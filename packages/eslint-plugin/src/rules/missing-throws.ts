import type { Rule } from "eslint";
import { DOCS_URL, getDiagnostics, locationOf, OPTIONS_SCHEMA, type RuleOptions } from "../analysis.js";

const rule: Rule.RuleModule = {
  meta: {
    type: "problem",
    docs: {
      description:
        "require a JSDoc @throws tag on every function that can throw or reject",
      recommended: true,
      url: DOCS_URL,
    },
    fixable: "code",
    schema: OPTIONS_SCHEMA,
    messages: {
      missingThrows: "{{message}}",
    },
  },
  create(context) {
    const options = (context.options[0] ?? {}) as RuleOptions;
    return {
      Program() {
        for (const d of getDiagnostics(context, "missing-throws", options)) {
          if (d.kind !== "missing-throws") continue;
          const fix = d.fix;
          context.report({
            messageId: "missingThrows",
            data: { message: d.message },
            loc: locationOf(context, d, d.functionName.length),
            fix:
              fix === undefined
                ? null
                : (fixer) => fixer.replaceTextRange([fix.start, fix.end], fix.text),
          });
        }
      },
    };
  },
};

export default rule;
