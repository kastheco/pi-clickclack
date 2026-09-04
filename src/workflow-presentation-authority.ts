const externalPresenterKey = Symbol.for("pi-workflows.external-human-decision-presenter.v1");

type ExternalPresenterRegistry = {
  registrations: number;
};

/**
 * Marks this process as having an external authority for workflow decisions.
 *
 * The Pi Workflows extension reads the same process-local symbol and leaves
 * decision claims to the ClickClack watcher while continuing to deliver agent
 * steps normally.
 */
export function registerExternalWorkflowDecisionPresenter(): () => void {
  const globals = globalThis as typeof globalThis & {
    [externalPresenterKey]?: unknown;
  };
  const current = globals[externalPresenterKey];
  const registry = isRegistry(current) ? current : { registrations: 0 };
  globals[externalPresenterKey] = registry;
  registry.registrations += 1;
  let registered = true;

  return () => {
    if (!registered) return;
    registered = false;
    registry.registrations = Math.max(0, registry.registrations - 1);
    if (registry.registrations === 0 && globals[externalPresenterKey] === registry) {
      delete globals[externalPresenterKey];
    }
  };
}

export function hasExternalWorkflowDecisionPresenter(): boolean {
  const globals = globalThis as typeof globalThis & {
    [externalPresenterKey]?: unknown;
  };
  const registry = globals[externalPresenterKey];
  return isRegistry(registry) && registry.registrations > 0;
}

function isRegistry(value: unknown): value is ExternalPresenterRegistry {
  return typeof value === "object"
    && value !== null
    && "registrations" in value
    && typeof value.registrations === "number";
}
