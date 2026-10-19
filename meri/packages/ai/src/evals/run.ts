import { resolve } from "node:path";
import { main } from "./capture";

main(resolve(import.meta.dirname, "../../../..")).catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
