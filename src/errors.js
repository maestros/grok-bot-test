export class ResearchError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "ResearchError";
    this.code = code;
  }
}
