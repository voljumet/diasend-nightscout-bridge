import { startSynchronization } from ".";

void startSynchronization();

const PORT = process.env.PORT || 3000;
run.listen(PORT, () => {
    console.log(`App is running on port ${ PORT }`);
});