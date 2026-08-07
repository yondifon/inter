/**
 * An expected, actionable CLI refusal. The top-level gate prints one clean
 * `error:` line on stderr and exits non-zero; anything else thrown at the top
 * level is a bug and keeps its stack.
 */
export class CliRefusal extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliRefusal";
  }
}
