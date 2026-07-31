export class DurableObject<Env = unknown, Props = unknown> {
  protected ctx: DurableObjectState<Props>;
  protected env: Env;

  constructor(ctx: DurableObjectState<Props>, env: Env) {
    this.ctx = ctx;
    this.env = env;
  }
}

export class RpcTarget {}

export class WorkflowEntrypoint {}

export const env = {};
