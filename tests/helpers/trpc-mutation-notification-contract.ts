import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";

export type SourceInput = {
  path: string;
  text: string;
};

export type TrpcMutationDeclaration = {
  path: string;
  sourceFile: string;
  line: number;
  routerName: string;
  procedureName: string;
};

export type ContractViolation = {
  code:
    | "DUPLICATE_POLICY_PATH"
    | "COMPUTED_MUTATION_MEMBER"
    | "ESCAPED_MUTATION_MEMBER"
    | "INVALID_POLICY"
    | "MISSING_POLICY"
    | "UNMOUNTED_ROUTER"
    | "UNPARSEABLE_MUTATION"
    | "UNUSED_POLICY";
  message: string;
};

type SourceWithAst = SourceInput & { ast: ts.SourceFile };

function propertyName(name: ts.PropertyName): string | null {
  if (ts.isIdentifier(name) || ts.isStringLiteral(name)) return name.text;
  return null;
}

function identifierName(expression: ts.Expression): string | null {
  return ts.isIdentifier(expression) ? expression.text : null;
}

function isCallNamed(node: ts.Node, name: string): node is ts.CallExpression {
  return ts.isCallExpression(node) && identifierName(node.expression) === name;
}

function parseSources(inputs: readonly SourceInput[]): SourceWithAst[] {
  return inputs.map((input) => ({
    ...input,
    ast: ts.createSourceFile(
      input.path,
      input.text,
      ts.ScriptTarget.Latest,
      true,
    ),
  }));
}

function appRouterMounts(
  sources: readonly SourceWithAst[],
): Map<string, string> {
  const mounts = new Map<string, string>();

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.name.text === "appRouter" &&
        node.initializer &&
        isCallNamed(node.initializer, "router")
      ) {
        const object = node.initializer.arguments[0];
        if (!object || !ts.isObjectLiteralExpression(object)) return;
        for (const property of object.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const namespace = propertyName(property.name);
          const routerName = identifierName(property.initializer);
          if (namespace && routerName) mounts.set(routerName, namespace);
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }

  return mounts;
}

function parentProcedureContext(
  mutation: ts.CallExpression,
): { routerName: string; procedureName: string } | null {
  let procedureName: string | null = null;
  let routerName: string | null = null;

  for (
    let current: ts.Node | undefined = mutation.parent;
    current;
    current = current.parent
  ) {
    if (!procedureName && ts.isPropertyAssignment(current)) {
      procedureName = propertyName(current.name);
    }
    if (
      ts.isObjectLiteralExpression(current) &&
      current.parent &&
      isCallNamed(current.parent, "router")
    ) {
      for (
        let owner: ts.Node | undefined = current.parent.parent;
        owner;
        owner = owner.parent
      ) {
        if (ts.isVariableDeclaration(owner) && ts.isIdentifier(owner.name)) {
          routerName = owner.name.text;
          break;
        }
      }
      break;
    }
  }

  return routerName && procedureName ? { routerName, procedureName } : null;
}

export function discoverTrpcMutations(inputs: readonly SourceInput[]): {
  declarations: TrpcMutationDeclaration[];
  violations: ContractViolation[];
} {
  const sources = parseSources(inputs);
  const mounts = appRouterMounts(sources);
  const declarations: TrpcMutationDeclaration[] = [];
  const violations: ContractViolation[] = [];

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isElementAccessExpression(node) &&
        ts.isStringLiteral(node.argumentExpression) &&
        node.argumentExpression.text === "mutation"
      ) {
        const line =
          source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast))
            .line + 1;
        violations.push({
          code: "COMPUTED_MUTATION_MEMBER",
          message: `${source.path}:${line} usa acesso computado a mutation; use a chamada tRPC direta para que o inventário seja verificável.`,
        });
      }
      if (
        ts.isPropertyAccessExpression(node) &&
        node.name.text === "mutation" &&
        (!ts.isCallExpression(node.parent) || node.parent.expression !== node)
      ) {
        const line =
          source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast))
            .line + 1;
        violations.push({
          code: "ESCAPED_MUTATION_MEMBER",
          message: `${source.path}:${line} referencia .mutation fora de uma chamada direta; aliases não são permitidos.`,
        });
      }
      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name)
      ) {
        for (const binding of node.name.elements) {
          const property = binding.propertyName
            ? propertyName(binding.propertyName)
            : ts.isIdentifier(binding.name)
              ? binding.name.text
              : null;
          if (property !== "mutation") continue;
          const line =
            source.ast.getLineAndCharacterOfPosition(
              binding.getStart(source.ast),
            ).line + 1;
          violations.push({
            code: "ESCAPED_MUTATION_MEMBER",
            message: `${source.path}:${line} desestrutura mutation; aliases não são permitidos.`,
          });
        }
      }
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        node.expression.name.text === "mutation"
      ) {
        const context = parentProcedureContext(node);
        if (!context) {
          const line =
            source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast))
              .line + 1;
          violations.push({
            code: "UNPARSEABLE_MUTATION",
            message: `${source.path}:${line} mutation não pertence a uma propriedade de router({ ... }).`,
          });
        } else {
          const namespace = mounts.get(context.routerName);
          if (!namespace) {
            violations.push({
              code: "UNMOUNTED_ROUTER",
              message: `${source.path} usa ${context.routerName}.${context.procedureName}, mas esse router não está montado no appRouter.`,
            });
          } else {
            const line =
              source.ast.getLineAndCharacterOfPosition(
                node.getStart(source.ast),
              ).line + 1;
            declarations.push({
              path: `${namespace}.${context.procedureName}`,
              sourceFile: source.path,
              line,
              routerName: context.routerName,
              procedureName: context.procedureName,
            });
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }

  return { declarations, violations };
}

export function verifyTrpcMutationPolicyInventory(
  inputs: readonly SourceInput[],
  inventory: Readonly<Record<string, string>>,
  allowedPolicies: readonly string[],
): ContractViolation[] {
  const { declarations, violations } = discoverTrpcMutations(inputs);
  const seen = new Set<string>();

  for (const declaration of declarations) {
    if (seen.has(declaration.path)) {
      violations.push({
        code: "DUPLICATE_POLICY_PATH",
        message: `${declaration.path} foi declarado por mais de uma mutation tRPC.`,
      });
      continue;
    }
    seen.add(declaration.path);
    if (!(declaration.path in inventory)) {
      violations.push({
        code: "MISSING_POLICY",
        message: `${declaration.sourceFile}:${declaration.line} (${declaration.path}) não possui política de notificação.`,
      });
    }
  }

  for (const policyPath of Object.keys(inventory)) {
    if (!allowedPolicies.includes(inventory[policyPath])) {
      violations.push({
        code: "INVALID_POLICY",
        message: `${policyPath} usa uma política de notificação inválida.`,
      });
    }
    if (!seen.has(policyPath)) {
      violations.push({
        code: "UNUSED_POLICY",
        message: `${policyPath} está no inventário, mas não corresponde a uma mutation tRPC montada.`,
      });
    }
  }

  return violations;
}

function walkTypeScriptFiles(directory: string): string[] {
  const files: string[] = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...walkTypeScriptFiles(entryPath));
    } else if (entry.isFile() && entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }
  return files;
}

/** Reads every server source file so a new router cannot silently bypass CI. */
export function readServerTypeScriptSources(root = "server"): SourceInput[] {
  return walkTypeScriptFiles(root)
    .sort()
    .map((path) => ({ path, text: readFileSync(path, "utf8") }));
}

export function inspectSsoOneTimeLaunchGet(
  sourceText: string,
  path = "server/sso/router.ts",
): { launchHandlers: number; redeemCalls: number } {
  const source = ts.createSourceFile(
    path,
    sourceText,
    ts.ScriptTarget.Latest,
    true,
  );
  let launchHandlers = 0;
  let redeemCalls = 0;

  const countRedeemCalls = (node: ts.Node): void => {
    if (isCallNamed(node, "redeemLaunchCode")) redeemCalls += 1;
    ts.forEachChild(node, countRedeemCalls);
  };

  const visit = (node: ts.Node): void => {
    if (
      ts.isCallExpression(node) &&
      ts.isPropertyAccessExpression(node.expression) &&
      ts.isIdentifier(node.expression.expression) &&
      node.expression.expression.text === "ssoRouter" &&
      node.expression.name.text === "get" &&
      ts.isStringLiteral(node.arguments[0]) &&
      node.arguments[0].text === "/launch"
    ) {
      launchHandlers += 1;
      const handler = node.arguments[1];
      if (handler) countRedeemCalls(handler);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);

  return { launchHandlers, redeemCalls };
}
