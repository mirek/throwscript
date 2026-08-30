import type { Rule } from "eslint";
import { DOCS_URL, getDiagnostics, locationOf, OPTIONS_SCHEMA, type RuleOptions } from "../analysis.js";

const rule: Rule.RuleModule = {
  meta: {
    type: "suggestion",
    docs: {
      description:
        "disallow JSDoc @throws tags for error types nothing observable throws",
      recommended: true,
      url: DOCS_URL,
    },
    schema: OPTIONS_SCHEMA,
    messages: {
      unusedThrows: "{{message}}",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as RuleOptions;
    return {
      Program() {
        for (const d of getDiagnostics(context, "unused-throws", options)) {
          if (d.kind !== "unused-throws") continue;
          context.report({
            messageId: "unusedThrows",
            data: { message: d.message },
            loc: locationOf(context, d, "@throws".length),
          });
        }
      },
    };
  },
};

export default rule;
