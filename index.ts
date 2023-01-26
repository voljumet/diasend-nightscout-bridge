require('dotenv').config({ path: `.env` })
import config from "./config";
import dayjs from "dayjs";
import relativeTime from "dayjs/plugin/relativeTime";
import {
  obtainDiasendAccessToken,
  getPatientData,
  GlucoseUnit,
  GlucoseRecord,
  CarbRecord,
  BolusRecord,
} from "./diasend";
import {
  SensorGlucoseValueEntry,
  reportEntriesToNightscout,
  MealBolusTreatment,
  reportTreatmentsToNightscout,
  Treatment,
  CorrectionBolusTreatment,
} from "./nightscout";
import { Console } from "console";

dayjs.extend(relativeTime);
// print the date used for the query


function diasendGlucoseRecordToNightscoutEntry(
  record: GlucoseRecord
): SensorGlucoseValueEntry {
  // FIXME: The created_at datetimes from diasend do not contain any timezone information which can be problematic
  var date = new Date(record.created_at);
  // remove two hours from the date to get the correct timezone
  // date.setHours(date.getHours() + 2);
  return {
    type: "sgv",
    direction: undefined, // TODO: we currently cannot obtain the direction / trend from diasend
    sgv: record.value,
    dateString: date.toISOString(),
    date: date.getTime(),
    units: record.unit === "mmol/l" ? "mmol" : "mg",
    app: "diasend",
    device: `${record.device.model} (${record.device.serial})`,
  };
}

interface SyncDiasendDataToNightScoutArgs {
  diasendUsername?: string;
  diasendPassword?: string;
  diasendClientId?: string;
  diasendClientSecret?: string;
  nightscoutEntriesHandler?: (
    entries: SensorGlucoseValueEntry[]
  ) => Promise<SensorGlucoseValueEntry[] | undefined>;
  nightscoutTreatmentsHandler?: (
    treatments: Treatment[]
  ) => Promise<Treatment[] | undefined>;
  dateFrom?: Date;
  dateTo?: Date;
  glucoseUnit?: GlucoseUnit;
}

async function syncDiasendDataToNightscout({
  diasendUsername = config.diasend.username,
  diasendPassword = config.diasend.password,
  diasendClientId = config.diasend.clientId,
  diasendClientSecret = config.diasend.clientSecret,
  nightscoutEntriesHandler = async (entries) =>
    await reportEntriesToNightscout(entries),
  nightscoutTreatmentsHandler = async (treatments) =>
    await reportTreatmentsToNightscout(treatments),
  dateFrom = dayjs().subtract(10, "minutes").toDate(),
  dateTo = new Date(),
  glucoseUnit = config.units.glucose,
}: SyncDiasendDataToNightScoutArgs) {
  if (!diasendUsername) {
    throw Error("Diasend Username not configured");
  }
  if (!diasendPassword) {
    throw Error("Diasend Password not configured");
  }

  const { access_token: diasendAccessToken } = await obtainDiasendAccessToken(
    diasendClientId,
    diasendClientSecret,
    diasendUsername,
    diasendPassword
  );

  // using the diasend token, now fetch the patient records
  const records = await getPatientData(
    diasendAccessToken,
    dateFrom,
    dateTo,
    glucoseUnit
  );
  // console log how many records we got 
  console.log(
    "In the last",dayjs(dateFrom).toNow(true),
    "there are",records.length,
    "new records from Diasend"
  );

  // extract all CGM values first
  const nightscoutEntries = records
    // TODO: support non-glucose type values
    // TODO: treat calibration events differently?
    .filter<GlucoseRecord>(
      (record): record is GlucoseRecord => record.type === "glucose"
    )
    .map(diasendGlucoseRecordToNightscoutEntry);

  // handle insulin boli
  const nightscoutTreatments = records
    .filter<CarbRecord | BolusRecord>(
      (record): record is CarbRecord | BolusRecord =>
        ["insulin_bolus", "carb"].includes(record.type)
    )
    .reduce<(MealBolusTreatment | CorrectionBolusTreatment)[]>(
      (treatments, record, _index, allRecords) => {
        // we only care about boli
        if (record.type === "carb") {
          return treatments;
        }

        const bolusRecord = record;
        // for a (meal) bolus, find the corresponding carbs record, if any
        // the carbs record is usually added ~1 minute later to diasend than the bolus for some reason
        // if it's not a meal bolus, it's a correction bolus
        const isMealBolus = "programmed_meal" in bolusRecord;
        if (isMealBolus) {
          const carbRecord = allRecords
            .filter<CarbRecord>((r): r is CarbRecord => r.type === "carb")
            .find(
              (r) =>
                // carbs should have been recorded within the next minute after bolus
                new Date(r.created_at) > new Date(bolusRecord.created_at) &&
                new Date(r.created_at).getTime() -
                  new Date(bolusRecord.created_at).getTime() <=
                  60 * 1000
            );

          if (!carbRecord) {
            // FIXME: schedule another run if carb event not yet found
            console.warn("Could not find corresponding carb value for bolus");
          } else {
            treatments.push({
              eventType: "Meal Bolus",
              insulin: bolusRecord.total_value,
              carbs: parseInt(carbRecord.value),
              notes: bolusRecord.programmed_bg_correction
                ? `Correction: ${bolusRecord.programmed_bg_correction}`
                : undefined,
              app: "diasend",
              date: new Date(bolusRecord.created_at).getTime(),
              device: `${bolusRecord.device.model} (${bolusRecord.device.serial})`,
            });
          }
        } else {
          if (bolusRecord.programmed_bg_correction) {
            treatments.push({
              eventType: "Correction Bolus",
              insulin: bolusRecord.programmed_bg_correction,
              app: "diasend",
              date: new Date(bolusRecord.created_at).getTime(),
              device: `${bolusRecord.device.model} (${bolusRecord.device.serial})`,
            });
          } else {
            console.warn("Bolus record cannot be handled", bolusRecord);
          }
        }

        return treatments;
      },
      []
    );
  if (nightscoutEntries.length != 0)
    console.log(`Sending ${nightscoutEntries.length} entries to nightscout`);
  
  if (nightscoutTreatments.length != 0)
    console.log(`Sending ${nightscoutTreatments.length} treatments to nightscout`);
  
    // send them to nightscout
  return await Promise.all([
    nightscoutEntriesHandler(nightscoutEntries),
    nightscoutTreatmentsHandler(nightscoutTreatments),
  ]);
}

// CamAPSFx uploads data to diasend every 5 minutes. (Which is also the time after which new CGM values from Dexcom will be available)
const interval = 60 * 1000;

let synchronizationTimeoutId: NodeJS.Timeout | undefined | number;
export function startSynchronization({
  pollingIntervalMs = interval,
  dateFrom = dayjs().subtract(interval, "milliseconds").toDate(),
  ...syncArgs
}: {
  pollingIntervalMs?: number;
} & SyncDiasendDataToNightScoutArgs = {}) {
  let nextDateFrom: Date = dateFrom;
  syncDiasendDataToNightscout({ dateFrom, ...syncArgs })
    .then(([records]) => {
      if (records && records.length) {
        // next run's data should be fetched where this run ended, so take a look at the records
        nextDateFrom = new Date(records[records.length - 1].date + 1000);
      }
    })
    .finally(() => {
      // schedule the next run
      var nextTime = new Date();
      var nextUnit = Number(process.env.UPDATE_INTERVAL);
      // cast to number
      const time = `${nextTime.getHours()}:${nextTime.getMinutes()+ nextUnit}`;
      console.log("Querying data from " + dayjs().subtract(1, "day").format("YYYY-MM-DD HH:mm:ss") + " to " + dayjs().format("YYYY-MM-DD HH:mm:ss"));
      console.log(
        `Next fetch from Diasend will be done: ${time} ...`
      );
      // if synchronizationTimeoutId is set to 0 when we get here, don't schedule a re-run. This is the exit condition
      // and prevents the synchronization loop from continuing if the timeout is cleared while already running the sync
      if (synchronizationTimeoutId !== 0) {
        synchronizationTimeoutId = setTimeout(() => {
          void startSynchronization({
            pollingIntervalMs,
            ...syncArgs,
            dateFrom: nextDateFrom,
          });
        }, pollingIntervalMs);
      }
    });

  // return a function that can be used to end the loop
  return () => {
    clearTimeout(synchronizationTimeoutId);
  };
}
