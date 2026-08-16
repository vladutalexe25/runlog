import jsep from "jsep";

/**
 * Evaluates a `transform`/`condition` node's expression without ever
 * calling `eval`/`new Function` — those run in the same process as the
 * server, with full access to `process`, `fetch`, and `import()`, which is
 * enough for a workflow author (or, given this API has no auth, anyone) to
 * read env vars/secrets or execute arbitrary shell commands. See
 * DECISIONS.md.
 *
 * Instead: parse the expression into an AST (jsep — a parser only, it
 * never executes anything) and walk it with a tree-walking evaluator that
 * implements exactly the node types below and nothing else. There is no
 * generic "look up this identifier and call it" path anywhere in this
 * file, so even though jsep's grammar can *parse* a function call
 * (`import(...)`, `foo()`), there is nothing here that will *run* one —
 * CallExpression falls through to the default case and throws. The only
 * identifiers that resolve to a real value are `input` and `context`;
 * everything else (`process`, `global`, ...) throws "unknown identifier"
 * before ever touching the real objects those names refer to elsewhere in
 * this process.
 */

interface Scope {
  input: unknown;
  context: unknown;
}

const BLOCKED_PROPERTIES = new Set(["__proto__", "constructor", "prototype"]);

function evalNode(node: jsep.Expression, scope: Scope): unknown {
  switch (node.type) {
    case "Literal":
      return (node as jsep.Literal).value;

    case "Identifier": {
      const { name } = node as jsep.Identifier;
      if (name === "input") return scope.input;
      if (name === "context") return scope.context;
      throw new Error(`unknown identifier "${name}" — only "input" and "context" are available`);
    }

    case "MemberExpression": {
      const m = node as jsep.MemberExpression;
      const obj = evalNode(m.object, scope);
      const key = m.computed ? evalNode(m.property, scope) : (m.property as jsep.Identifier).name;
      if (typeof key === "string" && BLOCKED_PROPERTIES.has(key)) {
        throw new Error(`access to "${key}" is not allowed`);
      }
      if (obj === null || obj === undefined) return undefined;
      return (obj as Record<string | number, unknown>)[key as string | number];
    }

    case "UnaryExpression": {
      const u = node as jsep.UnaryExpression;
      const arg = evalNode(u.argument, scope);
      switch (u.operator) {
        case "-":
          return -(arg as number);
        case "+":
          return +(arg as number);
        case "!":
          return !arg;
        default:
          throw new Error(`unary operator "${u.operator}" is not supported`);
      }
    }

    case "BinaryExpression": {
      const b = node as jsep.BinaryExpression;
      // && and || short-circuit — the right side must not be evaluated
      // (and its side effects, if any were possible here, must not run)
      // unless the left side actually requires it.
      if (b.operator === "&&") {
        const left = evalNode(b.left, scope);
        return left ? evalNode(b.right, scope) : left;
      }
      if (b.operator === "||") {
        const left = evalNode(b.left, scope);
        return left ? left : evalNode(b.right, scope);
      }
      if (b.operator === "??") {
        const left = evalNode(b.left, scope);
        return left ?? evalNode(b.right, scope);
      }

      const left = evalNode(b.left, scope) as never;
      const right = evalNode(b.right, scope) as never;
      switch (b.operator) {
        case "+":
          return (left as unknown as number) + (right as unknown as number);
        case "-":
          return left - right;
        case "*":
          return left * right;
        case "/":
          return left / right;
        case "%":
          return left % right;
        case "==":
          return left == right; // eslint-disable-line eqeqeq
        case "!=":
          return left != right; // eslint-disable-line eqeqeq
        case "===":
          return left === right;
        case "!==":
          return left !== right;
        case "<":
          return left < right;
        case ">":
          return left > right;
        case "<=":
          return left <= right;
        case ">=":
          return left >= right;
        default:
          throw new Error(`operator "${b.operator}" is not supported`);
      }
    }

    case "ConditionalExpression": {
      const c = node as jsep.ConditionalExpression;
      return evalNode(c.test, scope) ? evalNode(c.consequent, scope) : evalNode(c.alternate, scope);
    }

    case "ArrayExpression": {
      const a = node as jsep.ArrayExpression;
      return a.elements.map((el) => (el === null ? undefined : evalNode(el, scope)));
    }

    default:
      throw new Error(
        `expression syntax "${node.type}" is not supported — allowed: property access on ` +
          `input/context, literals, arithmetic, comparisons, &&/||/??, ternary, arrays. ` +
          `Function calls are never allowed.`,
      );
  }
}

export function evaluateExpression(expression: string, input: unknown, context: unknown): unknown {
  let ast: jsep.Expression;
  try {
    ast = jsep(expression);
  } catch (err) {
    throw new Error(`invalid expression: ${err instanceof Error ? err.message : String(err)}`);
  }
  return evalNode(ast, { input, context });
}
