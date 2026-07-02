export type E2EErrorCode = "NO_OWN_KEY" | "NO_RECIPIENT_KEY" | "ENCRYPT_FAILED";

export class E2EError extends Error {
  readonly code: E2EErrorCode;

  constructor(code: E2EErrorCode, message: string) {
    super(message);
    this.name = "E2EError";
    this.code = code;
  }
}
