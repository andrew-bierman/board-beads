import type {
  BoardLabels,
  LabelGuardResult,
  LabelRefusal,
  LabelsApi,
} from "./types.ts";

/**
 * Board's own reserved label prefix. A caller may never set it — that prefix is how
 * the board itself marks tasks and the like. Fixed, not parameterized: it is Board's
 * rule, not ours.
 */
export const RESERVED_LABEL_PREFIX = "board.";

/**
 * The bd-label encoding: `name=value`, split on the first `=`. Bijective for any value
 * (values may contain `=`); a name containing `=` or an empty name can't encode, so the
 * guard refuses them as `invalid_label` before a write is attempted.
 */
export function createLabels(options?: { namespace?: string }): LabelsApi {
  const namespace = options?.namespace ?? "bb";
  const ownPrefix = `${namespace}.`;

  const isOwnLabel = (name: string): boolean => name.startsWith(ownPrefix);

  const guardCallerLabel = (name: string): LabelRefusal | null => {
    if (name.startsWith(RESERVED_LABEL_PREFIX)) {
      return { code: "reserved_label", label: name };
    }
    if (isOwnLabel(name)) {
      return { code: "reserved_label", label: name };
    }
    if (name.length === 0 || name.includes("=")) {
      return { code: "invalid_label", label: name };
    }
    return null;
  };

  const guardCallerLabels = (labels: BoardLabels): LabelGuardResult => {
    for (const name of Object.keys(labels).sort()) {
      const refusal = guardCallerLabel(name);
      if (refusal) return { ok: false, error: refusal };
    }
    return { ok: true };
  };

  const toBdLabels = (labels: BoardLabels): string[] =>
    Object.keys(labels)
      .sort()
      .map((name) => {
        const value = labels[name];
        return value === undefined || value === "" ? name : `${name}=${value}`;
      });

  const fromBdLabels = (bdLabels: readonly string[]): BoardLabels => {
    const labels: Record<string, string> = {};
    for (const bdLabel of bdLabels) {
      const eq = bdLabel.indexOf("=");
      const name = eq === -1 ? bdLabel : bdLabel.slice(0, eq);
      const value = eq === -1 ? "" : bdLabel.slice(eq + 1);
      if (isOwnLabel(name)) continue;
      if (name.length > 0) labels[name] = value;
    }
    return labels;
  };

  return {
    namespace,
    isOwnLabel,
    guardCallerLabel,
    guardCallerLabels,
    toBdLabels,
    fromBdLabels,
  };
}
