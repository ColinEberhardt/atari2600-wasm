import { CPU } from "./cpu";
import StatusRegister from "./statusRegister";
import Memory from "./memory";
import TIA from "./tia";

const memory = new Memory();
const cpu = new CPU(memory);
const tia = new TIA(memory, cpu);

export { tia, cpu, memory as consoleMemory, CPU, StatusRegister, Memory, TIA };
