import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

export async function promptUser(message: string): Promise<string> {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(message);
    return answer.trim();
  } finally {
    rl.close();
  }
}
