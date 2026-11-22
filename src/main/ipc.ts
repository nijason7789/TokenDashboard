import { RENDERER_URL } from "../shared/contract";

type Frame = { url: string };
type Owner = { mainFrame: Frame };

export function createStatusHandler<T>(owner: Owner, readStatus: () => T) {
  return createWindowHandler(owner, readStatus, (args) => args.length === 0);
}

export function createWindowHandler<T>(
  owner: Owner,
  action: (...args: unknown[]) => T,
  valid: (args: unknown[]) => boolean,
) {
  return (
    event: { sender: Owner; senderFrame: Frame | null },
    ...args: unknown[]
  ) => {
    if (
      event.sender !== owner ||
      event.senderFrame !== owner.mainFrame ||
      event.senderFrame?.url !== RENDERER_URL ||
      !valid(args)
    ) {
      throw new Error("Unauthorized quota request");
    }

    return action(...args);
  };
}
