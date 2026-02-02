import { Parser } from "acorn"
import jsx from "acorn-jsx"
import * as walk from "acorn-walk"
import escodegen from "escodegen"

const JSXParser = Parser.extend(jsx())

// --- Parser ---
export function parse(code) {
  return JSXParser.parse(code, {
    ecmaVersion: "latest",
    sourceType: "module"
  })
}

function jsxNameToId(name) {
  if (name.type === "JSXIdentifier") {
    let id = name.name.replace(/[^A-Za-z0-9_$]/g, "_");
    if (/^[0-9]/.test(id)) id = "_" + id;
    return { type: "Identifier", name: id };
  }
  throw new Error("Unsupported JSX name")
}

function transformAttributes(attrs) {
  if (!attrs.length) return null

  return {
    type: "ObjectExpression",
    properties: attrs.map(attr => ({
      type: "Property",
      key: { type: "Identifier", name: attr.name.name },
      value: attr.value
        ? attr.value.type === "Literal"
          ? attr.value
          : attr.value.expression
        : { type: "Literal", value: true },
      kind: "init"
    }))
  }
}

function transformChild(child) {
  if (!child) return null

  switch (child.type) {
    case "JSXText": {
      const text = child.value.trim()
      if (!text) return null
      return { type: "Literal", value: text }
    }

    case "JSXExpressionContainer":
      return child.expression

    case "JSXElement":
      return transformJSX(child)

    default:
      return child
  }
}

function transformJSX(node) {
  const tag = jsxNameToId(node.openingElement.name)

  const attrs = transformAttributes(node.openingElement.attributes)
  const children = node.children
    .map(transformChild)
    .filter(Boolean)

  return {
    type: "CallExpression",
    callee: tag,
    arguments: [
      ...(attrs ? [attrs] : []),
      ...children
    ]
  }
}

// --- Transformer ---
export function transform(ast) {
  const baseWithJSX = Object.assign({}, walk.base, {
    JSXElement(node, state, visit) {
      // traverse opening element, children and closing element
      if (node.openingElement) 
        visit(node.openingElement, state, "JSXOpeningElement");
      for (let i = 0; i < (node.children || []).length; i++) 
        visit(node.children[i], state);
      if (node.closingElement) 
        visit(node.closingElement, state, "JSXClosingElement");
    },
    JSXOpeningElement(node, state, visit) {
      if (node.name) visit(node.name, state);
      for (let i = 0; i < (node.attributes || []).length; i++) {
        visit(node.attributes[i], state);
      }
    },
    JSXClosingElement(node, state, visit) {
      if (node.name) visit(node.name, state);
    },
    JSXExpressionContainer(node, state, visit) {
      if (node.expression) visit(node.expression, state, "Expression");
    },
    JSXAttribute(node, state, visit) {
      if (node.name) visit(node.name, state);
      if (node.value) visit(node.value, state);
    },
    JSXText() {},
    JSXIdentifier() {}
  });

  const scopeTags = new Map();

  walk.ancestor(ast, {
    JSXElement(node, state, ancestors) {
        Object.assign(node, transformJSX(node));
      const tagName = node.callee && node.callee.name;
      if (!tagName) return;

      // Ignore capitalized names (components). Only collect lowercase/html tags.
      if (!/^[a-z]/.test(tagName)) return;

      const scope = ancestors.slice().reverse().find(a =>
        a.type === "ArrowFunctionExpression" ||
        a.type === "FunctionDeclaration" ||
        a.type === "FunctionExpression" ||
        a.type === "Program"
      );

      const set = scopeTags.get(scope) || new Set();
      set.add(tagName);
      scopeTags.set(scope, set);
    }
  }, baseWithJSX);

  for (const [scope, tags] of scopeTags) {
    const tagNames = Array.from(tags);
    if (!tagNames.length) continue;

    const decl = {
      type: "VariableDeclaration",
      kind: "const",
      declarations: [
        {
          type: "VariableDeclarator",
          id: {
            type: "ObjectPattern",
            properties: tagNames.map(n => ({
              type: "Property",
              key: { type: "Identifier", name: n },
              value: { type: "Identifier", name: n },
              kind: "init",
              method: false,
              shorthand: true,
              computed: false
            }))
          },
          init: { type: "Identifier", name: "tags" }
        }
      ]
    };

    if (scope.type === "Program") {
      const first = scope.body && scope.body[0];
      const already = first && first.type === "VariableDeclaration" && first.declarations && first.declarations.some(d => d.init && d.init.name === "tags");
      if (!already) scope.body.unshift(decl);
    } else {
      if (scope.body.type !== "BlockStatement") {
        scope.body = { type: "BlockStatement", body: [{ type: "ReturnStatement", argument: scope.body }] };
        if (scope.type === "ArrowFunctionExpression") {
          scope.expression = false;
        }
      }
      const first = scope.body.body && scope.body.body[0];
      const already = first && first.type === "VariableDeclaration" && first.declarations && first.declarations.some(d => d.init && d.init.name === "tags");
      if (!already) scope.body.body.unshift(decl);
    }
  }

  // If any tags are used, ensure `import { tags } from 'ziko/ui'` exists at the program top
  if (ast && ast.type === "Program") {
    const usesTags = Array.from(scopeTags.values()).some(set => set.size > 0);
    if (usesTags) {
      const hasImport = ast.body.some(node =>
        node.type === "ImportDeclaration" &&
        node.specifiers && node.specifiers.some(sp =>
          (sp.type === "ImportSpecifier" || sp.type === "ImportDefaultSpecifier" || sp.type === "ImportNamespaceSpecifier") &&
          sp.local && sp.local.name === "tags"
        )
      );

      const hasVarOrFn = ast.body.some(node =>
        (node.type === "VariableDeclaration" && node.declarations && node.declarations.some(d =>
          (d.id && d.id.type === "Identifier" && d.id.name === "tags") ||
          (d.id && d.id.type === "ObjectPattern" && d.id.properties && d.id.properties.some(p => p.key && p.key.name === "tags"))
        )) || (node.type === "FunctionDeclaration" && node.id && node.id.name === "tags")
      );

      if (!hasImport && !hasVarOrFn) {
        const importDecl = {
          type: "ImportDeclaration",
          specifiers: [
            {
              type: "ImportSpecifier",
              imported: { type: "Identifier", name: "tags" },
              local: { type: "Identifier", name: "tags" }
            }
          ],
          source: { type: "Literal", value: "ziko/ui" }
        };
        ast.body.unshift(importDecl);
      }
    }
  }

  return ast
}

// --- Compiler ---
export function compile(code) {
  const ast = parse(code)
  transform(ast)
  return escodegen.generate(ast)
}

const code = `
// import {tags} from 'ziko'
const App = ({ text = "world" } = {}) => (
  <div class="box" >
  <Comp a='kk'/>
    Hello
    <h1>Hello {text}</h1>
    <span>{count}</span>
    <custom-el></custom-el>
  </div>
)
`

console.log(
    compile(code)
)
