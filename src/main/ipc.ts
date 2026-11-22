import { RENDERER_URL } from "../shared/contract";

type Frame = { url: string };
type Owner = { mainFrame: Frame };

export function createStatusHandler<T>(owner: Owner, readStatus: () => T) {
  return (
    event: { sender: Owner; senderFrame: Frame | null },
    ...args: unknown[]
  ) => {
    if (
      event.sender !== owner ||
      event.senderFrame !== owner.mainFrame ||
      event.senderFrame?.url !== RENDERER_URL ||
      args.length !== 0
    ) {
      throw new Error("Unauthorized quota request");
    }

    return readStatus();
  };
}
