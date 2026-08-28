import type { SafetyRule } from "@/src/safety/types";

export const experimentalRule: SafetyRule = {
  ruleId: "SAFETY_EXPERIMENTAL",
  ruleVersion: 1,
  version: 1,
  title: "Experimental combination",
  severity: "WARN",
  conditions: [
    {
      id: "experimental-flag",
      description: "The combination has no reliable hazard evidence and is marked experimental.",
    },
  ],
  reason: "This unusual food combination has insufficient reliable evidence and is experimental.",
  alternative: "Use a familiar food combination if you prefer a lower-uncertainty recipe.",
  evidence: [
    {
      source: "Project safety policy",
      url: "https://github.com/openai/recipes",
      note: "Insufficient evidence is surfaced as a warning, not presented as a medical prohibition.",
    },
  ],
  matches: (input) =>
    input.experimental === true || input.ingredients.some((item) => item.experimental === true),
};

export default experimentalRule;
