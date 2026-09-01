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
    | "AMBIGUOUS_EXPRESS_ROUTER"
    | "COMPUTED_EXPRESS_METHOD"
    | "DUPLICATE_POLICY_PATH"
    | "DUPLICATE_EXPRESS_ENDPOINT"
    | "DYNAMIC_EXPRESS_METHOD"
    | "COMPUTED_MUTATION_MEMBER"
    | "ESCAPED_EXPRESS_METHOD"
    | "ESCAPED_MUTATION_MEMBER"
    | "INVALID_POLICY_TARGET"
    | "INVALID_TARGET_AUDIENCE"
    | "INVALID_TARGET_CONDITION"
    | "INVALID_TARGET_CONTRACT"
    | "MISSING_EXPRESS_POLICY"
    | "MISSING_POLICY"
    | "UNMOUNTED_EXPRESS_ROUTER"
    | "UNMOUNTED_ROUTER"
    | "UNPARSEABLE_EXPRESS_MOUNT"
    | "UNPARSEABLE_EXPRESS_ROUTE"
    | "UNPARSEABLE_MUTATION"
    | "UNSUPPORTED_EXPRESS_ROUTE_STYLE"
    | "UNUSED_EXPRESS_POLICY"
    | "UNUSED_POLICY";
  message: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validateNotificationTargetPolicy(
  policyPath: string,
  value: unknown,
  allowedPolicies: readonly string[],
  violations: ContractViolation[],
): void {
  if (
    !isRecord(value) ||
    !Array.isArray(value.targets) ||
    value.targets.length === 0
  ) {
    violations.push({
      code: "INVALID_TARGET_CONTRACT",
      message: `${policyPath} precisa declarar ao menos um target de notificação.`,
    });
    return;
  }

  for (const target of value.targets) {
    if (!isRecord(target)) {
      violations.push({
        code: "INVALID_TARGET_CONTRACT",
        message: `${policyPath} possui target de notificação inválido.`,
      });
      continue;
    }

    const policy = target.policy;
    if (typeof policy !== "string" || !allowedPolicies.includes(policy)) {
      violations.push({
        code: "INVALID_POLICY_TARGET",
        message: `${policyPath} usa uma política de notificação inválida.`,
      });
    }

    const when = target.when;
    if (typeof when !== "string" || when.trim().length === 0) {
      violations.push({
        code: "INVALID_TARGET_CONDITION",
        message: `${policyPath} precisa declarar quando o target se aplica.`,
      });
    }

    const audience = target.audience;
    const hasAudience =
      Array.isArray(audience) &&
      audience.every(
        (recipient) =>
          typeof recipient === "string" && recipient.trim().length > 0,
      ) &&
      new Set(audience).size === audience.length;
    if (!hasAudience) {
      violations.push({
        code: "INVALID_TARGET_AUDIENCE",
        message: `${policyPath} possui audiência de notificação inválida.`,
      });
      continue;
    }

    if (policy === "SILENT_AUDITED" && audience.length !== 0) {
      violations.push({
        code: "INVALID_TARGET_AUDIENCE",
        message: `${policyPath} silencioso não pode ter audiência.`,
      });
    }
    if (policy !== "SILENT_AUDITED" && audience.length === 0) {
      violations.push({
        code: "INVALID_TARGET_AUDIENCE",
        message: `${policyPath} notificável precisa ter audiência.`,
      });
    }
  }
}

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
  inventory: Readonly<Record<string, unknown>>,
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
    validateNotificationTargetPolicy(
      policyPath,
      inventory[policyPath],
      allowedPolicies,
      violations,
    );
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

const EXPRESS_MUTATION_METHODS = new Map([
  ["post", "POST"],
  ["put", "PUT"],
  ["patch", "PATCH"],
  ["delete", "DELETE"],
] as const);

type ExpressReceiverKind = "app" | "router";

type ExpressRouteReceiver = {
  key: string;
  name: string;
  sourceFile: string;
  kind: ExpressReceiverKind;
};

type ExpressReceiverCollection = {
  byKey: Map<string, ExpressRouteReceiver>;
  routersByName: Map<string, ExpressRouteReceiver[]>;
};

export type ExpressRouterMount = {
  routerName: string;
  mountPath: string;
  sourceFile: string;
  line: number;
};

export type ExpressMutationEndpointDeclaration = {
  endpoint: string;
  sourceFile: string;
  line: number;
  routerName: string;
  method: "POST" | "PUT" | "PATCH" | "DELETE";
  path: string;
};

function receiverKey(sourceFile: string, name: string): string {
  return `${sourceFile}\u0000${name}`;
}

function sourceLine(source: SourceWithAst, node: ts.Node): number {
  return (
    source.ast.getLineAndCharacterOfPosition(node.getStart(source.ast)).line + 1
  );
}

function callPropertyName(node: ts.CallExpression): string | null {
  return ts.isPropertyAccessExpression(node.expression)
    ? node.expression.name.text
    : null;
}

function isRouterFactoryCall(expression: ts.Expression): boolean {
  if (!ts.isCallExpression(expression)) return false;
  if (isCallNamed(expression, "Router")) return true;
  return (
    ts.isPropertyAccessExpression(expression.expression) &&
    expression.expression.name.text === "Router"
  );
}

function isExpressApplicationCall(expression: ts.Expression): boolean {
  return ts.isCallExpression(expression) && isCallNamed(expression, "express");
}

function typeName(type: ts.TypeNode | undefined): string | null {
  if (!type || !ts.isTypeReferenceNode(type)) return null;
  if (ts.isIdentifier(type.typeName)) return type.typeName.text;
  return type.typeName.right.text;
}

function isExpressApplicationParameter(
  parameter: ts.ParameterDeclaration,
): boolean {
  return typeName(parameter.type) === "Express";
}

function routeReceiverFor(
  collection: ExpressReceiverCollection,
  source: SourceWithAst,
  expression: ts.Expression,
): ExpressRouteReceiver | null {
  if (!ts.isIdentifier(expression)) return null;
  return (
    collection.byKey.get(receiverKey(source.path, expression.text)) ?? null
  );
}

function addRouteReceiver(
  collection: ExpressReceiverCollection,
  receiver: ExpressRouteReceiver,
): void {
  collection.byKey.set(receiver.key, receiver);
  if (receiver.kind !== "router") return;
  const named = collection.routersByName.get(receiver.name) ?? [];
  named.push(receiver);
  collection.routersByName.set(receiver.name, named);
}

/**
 * Finds real Express applications and Router() instances by AST, then follows
 * a root Express app passed to a statically named registration helper such as
 * registerOAuthRoutes(app). This keeps future mounted helpers covered without
 * treating unrelated HTTP clients as routes.
 */
function collectExpressRouteReceivers(
  sources: readonly SourceWithAst[],
): ExpressReceiverCollection {
  const collection: ExpressReceiverCollection = {
    byKey: new Map(),
    routersByName: new Map(),
  };
  const expressParametersByFunction = new Map<
    string,
    { source: SourceWithAst; index: number; name: string }[]
  >();

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isVariableDeclaration(node) &&
        ts.isIdentifier(node.name) &&
        node.initializer
      ) {
        const key = receiverKey(source.path, node.name.text);
        if (isRouterFactoryCall(node.initializer)) {
          addRouteReceiver(collection, {
            key,
            name: node.name.text,
            sourceFile: source.path,
            kind: "router",
          });
        } else if (isExpressApplicationCall(node.initializer)) {
          addRouteReceiver(collection, {
            key,
            name: node.name.text,
            sourceFile: source.path,
            kind: "app",
          });
        }
      }

      if (ts.isFunctionDeclaration(node) && node.name) {
        const expressParameters = node.parameters.flatMap((parameter, index) =>
          ts.isIdentifier(parameter.name) &&
          isExpressApplicationParameter(parameter)
            ? [{ source, index, name: parameter.name.text }]
            : [],
        );
        if (expressParameters.length > 0) {
          expressParametersByFunction.set(node.name.text, expressParameters);
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
        const parameters = expressParametersByFunction.get(
          node.expression.text,
        );
        if (parameters) {
          for (const parameter of parameters) {
            const argument = node.arguments[parameter.index];
            if (!argument) continue;
            const passedReceiver = routeReceiverFor(
              collection,
              source,
              argument,
            );
            if (passedReceiver?.kind !== "app") continue;
            const key = receiverKey(parameter.source.path, parameter.name);
            if (!collection.byKey.has(key)) {
              addRouteReceiver(collection, {
                key,
                name: parameter.name,
                sourceFile: parameter.source.path,
                kind: "app",
              });
            }
          }
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }

  return collection;
}

function staticRoutePaths(expression: ts.Expression): string[] | null {
  if (
    ts.isStringLiteral(expression) ||
    ts.isNoSubstitutionTemplateLiteral(expression)
  ) {
    return [expression.text];
  }
  if (!ts.isArrayLiteralExpression(expression)) return null;

  const paths: string[] = [];
  for (const element of expression.elements) {
    if (
      !ts.isStringLiteral(element) &&
      !ts.isNoSubstitutionTemplateLiteral(element)
    ) {
      return null;
    }
    paths.push(element.text);
  }
  return paths;
}

function normalizeRoutePath(path: string): string {
  const withLeadingSlash = path.startsWith("/") ? path : `/${path}`;
  if (withLeadingSlash === "/") return "/";
  return withLeadingSlash.replace(/\/+$/, "") || "/";
}

function joinRoutePaths(mountPath: string, routePath: string): string {
  const normalizedMount = normalizeRoutePath(mountPath);
  const normalizedRoute = normalizeRoutePath(routePath);
  if (normalizedMount === "/") return normalizedRoute;
  if (normalizedRoute === "/") return normalizedMount;
  return `${normalizedMount}${normalizedRoute}`;
}

function routeBuilderUsesMutationMethod(
  routeMember: ts.PropertyAccessExpression,
): boolean {
  if (
    !ts.isCallExpression(routeMember.parent) ||
    routeMember.parent.expression !== routeMember
  ) {
    return false;
  }
  const chainedMember = routeMember.parent.parent;
  return (
    ts.isPropertyAccessExpression(chainedMember) &&
    EXPRESS_MUTATION_METHODS.has(chainedMember.name.text)
  );
}

function mountsForKnownRouter(
  source: SourceWithAst,
  call: ts.CallExpression,
  collection: ExpressReceiverCollection,
  violations: ContractViolation[],
): { router: ExpressRouteReceiver; mountPath: string }[] {
  const mountReceiver =
    ts.isPropertyAccessExpression(call.expression) &&
    callPropertyName(call) === "use"
      ? routeReceiverFor(collection, source, call.expression.expression)
      : null;
  if (mountReceiver?.kind !== "app") return [];

  const mounts: { router: ExpressRouteReceiver; mountPath: string }[] = [];
  for (let index = 0; index < call.arguments.length; index += 1) {
    const argument = call.arguments[index];
    if (!ts.isIdentifier(argument)) continue;
    const candidates = collection.routersByName.get(argument.text) ?? [];
    if (candidates.length === 0) continue;
    if (candidates.length > 1) {
      violations.push({
        code: "AMBIGUOUS_EXPRESS_ROUTER",
        message: `${source.path}:${sourceLine(source, argument)} referencia o router ${argument.text}, mas há mais de uma declaração Router() com esse nome.`,
      });
      continue;
    }

    const pathArgument = call.arguments.find((candidate, candidateIndex) => {
      if (candidateIndex >= index) return false;
      return staticRoutePaths(candidate) !== null;
    });
    if (pathArgument) {
      const paths = staticRoutePaths(pathArgument);
      if (!paths) {
        violations.push({
          code: "UNPARSEABLE_EXPRESS_MOUNT",
          message: `${source.path}:${sourceLine(source, pathArgument)} usa mount Express sem caminho estático verificável.`,
        });
        continue;
      }
      for (const mountPath of paths) {
        mounts.push({ router: candidates[0], mountPath });
      }
      continue;
    }

    if (call.arguments.slice(0, index).length > 0) {
      violations.push({
        code: "UNPARSEABLE_EXPRESS_MOUNT",
        message: `${source.path}:${sourceLine(source, argument)} monta ${argument.text} com prefixo Express dinâmico ou ambíguo.`,
      });
      continue;
    }
    mounts.push({ router: candidates[0], mountPath: "/" });
  }

  return mounts;
}

function discoverExpressRouterMountsFromSources(
  sources: readonly SourceWithAst[],
): { mounts: ExpressRouterMount[]; violations: ContractViolation[] } {
  const collection = collectExpressRouteReceivers(sources);
  const mounts: ExpressRouterMount[] = [];
  const violations: ContractViolation[] = [];

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (ts.isCallExpression(node)) {
        for (const mount of mountsForKnownRouter(
          source,
          node,
          collection,
          violations,
        )) {
          mounts.push({
            routerName: mount.router.name,
            mountPath: normalizeRoutePath(mount.mountPath),
            sourceFile: source.path,
            line: sourceLine(source, node),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }

  return { mounts, violations };
}

/**
 * Lists mounted Router() instances only. The result deliberately excludes
 * unmounted helpers and HTTP clients; it represents the external Express
 * surface registered by an Express application.
 */
export function discoverExpressRouterMounts(inputs: readonly SourceInput[]): {
  mounts: ExpressRouterMount[];
  violations: ContractViolation[];
} {
  return discoverExpressRouterMountsFromSources(parseSources(inputs));
}

/**
 * Discovers every externally mounted Express POST/PUT/PATCH/DELETE endpoint.
 * Routes must use a direct static Router/app method so the inventory cannot be
 * bypassed through aliases, computed members or dynamic paths.
 */
export function discoverExpressMutationEndpoints(
  inputs: readonly SourceInput[],
): {
  declarations: ExpressMutationEndpointDeclaration[];
  violations: ContractViolation[];
} {
  const sources = parseSources(inputs);
  const collection = collectExpressRouteReceivers(sources);
  const mountDiscovery = discoverExpressRouterMountsFromSources(sources);
  const violations = [...mountDiscovery.violations];
  const mountPathsByRouter = new Map<string, string[]>();

  for (const mount of mountDiscovery.mounts) {
    const candidates = collection.routersByName.get(mount.routerName) ?? [];
    if (candidates.length !== 1) continue;
    const paths = mountPathsByRouter.get(candidates[0].key) ?? [];
    paths.push(mount.mountPath);
    mountPathsByRouter.set(candidates[0].key, paths);
  }

  const declarations: ExpressMutationEndpointDeclaration[] = [];

  for (const source of sources) {
    const visit = (node: ts.Node): void => {
      if (
        ts.isElementAccessExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        const receiver = routeReceiverFor(collection, source, node.expression);
        if (receiver) {
          if (ts.isStringLiteral(node.argumentExpression)) {
            if (EXPRESS_MUTATION_METHODS.has(node.argumentExpression.text)) {
              violations.push({
                code: "COMPUTED_EXPRESS_METHOD",
                message: `${source.path}:${sourceLine(source, node)} usa acesso computado a ${node.argumentExpression.text}; use método Express direto para que o inventário seja verificável.`,
              });
            }
          } else {
            violations.push({
              code: "DYNAMIC_EXPRESS_METHOD",
              message: `${source.path}:${sourceLine(source, node)} usa acesso dinâmico a um método Express; o contrato exige um método estático.`,
            });
          }
        }
      }

      if (
        ts.isPropertyAccessExpression(node) &&
        ts.isIdentifier(node.expression)
      ) {
        const receiver = routeReceiverFor(collection, source, node.expression);
        const method = EXPRESS_MUTATION_METHODS.get(node.name.text);
        if (receiver && method) {
          if (
            !ts.isCallExpression(node.parent) ||
            node.parent.expression !== node
          ) {
            violations.push({
              code: "ESCAPED_EXPRESS_METHOD",
              message: `${source.path}:${sourceLine(source, node)} referencia .${node.name.text} fora de chamada Express direta; aliases não são permitidos.`,
            });
          }
        }
        if (
          receiver &&
          node.name.text === "route" &&
          routeBuilderUsesMutationMethod(node)
        ) {
          violations.push({
            code: "UNSUPPORTED_EXPRESS_ROUTE_STYLE",
            message: `${source.path}:${sourceLine(source, node)} usa .route(); declare POST/PUT/PATCH/DELETE diretamente para manter o inventário verificável.`,
          });
        }
      }

      if (
        ts.isVariableDeclaration(node) &&
        ts.isObjectBindingPattern(node.name) &&
        node.initializer
      ) {
        const receiver = routeReceiverFor(collection, source, node.initializer);
        if (receiver) {
          for (const binding of node.name.elements) {
            const name = binding.propertyName
              ? propertyName(binding.propertyName)
              : ts.isIdentifier(binding.name)
                ? binding.name.text
                : null;
            if (!name || !EXPRESS_MUTATION_METHODS.has(name)) continue;
            violations.push({
              code: "ESCAPED_EXPRESS_METHOD",
              message: `${source.path}:${sourceLine(source, binding)} desestrutura ${name} de ${receiver.name}; aliases não são permitidos.`,
            });
          }
        }
      }

      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression)
      ) {
        const receiver = routeReceiverFor(
          collection,
          source,
          node.expression.expression,
        );
        const method = EXPRESS_MUTATION_METHODS.get(node.expression.name.text);
        if (receiver && method) {
          const routeArgument = node.arguments[0];
          if (!routeArgument) {
            violations.push({
              code: "UNPARSEABLE_EXPRESS_ROUTE",
              message: `${source.path}:${sourceLine(source, node)} declara ${method} sem caminho estático.`,
            });
          } else {
            const routePaths = staticRoutePaths(routeArgument);
            if (!routePaths) {
              violations.push({
                code: "UNPARSEABLE_EXPRESS_ROUTE",
                message: `${source.path}:${sourceLine(source, routeArgument)} declara ${method} com caminho Express não estático.`,
              });
            } else {
              const mountPaths =
                receiver.kind === "router"
                  ? mountPathsByRouter.get(receiver.key)
                  : ["/"];
              if (!mountPaths || mountPaths.length === 0) {
                violations.push({
                  code: "UNMOUNTED_EXPRESS_ROUTER",
                  message: `${source.path}:${sourceLine(source, node)} usa ${receiver.name}.${node.expression.name.text}, mas esse Router() não está montado em um app Express.`,
                });
              } else {
                for (const mountPath of mountPaths) {
                  for (const routePath of routePaths) {
                    const path = joinRoutePaths(mountPath, routePath);
                    declarations.push({
                      endpoint: `${method} ${path}`,
                      sourceFile: source.path,
                      line: sourceLine(source, node),
                      routerName: receiver.name,
                      method,
                      path,
                    });
                  }
                }
              }
            }
          }
        }
      }

      ts.forEachChild(node, visit);
    };
    visit(source.ast);
  }

  return { declarations, violations };
}

export function verifyExpressMutationPolicyInventory(
  inputs: readonly SourceInput[],
  inventory: Readonly<Record<string, unknown>>,
  allowedPolicies: readonly string[],
): ContractViolation[] {
  const { declarations, violations } = discoverExpressMutationEndpoints(inputs);
  const seen = new Set<string>();

  for (const declaration of declarations) {
    if (seen.has(declaration.endpoint)) {
      violations.push({
        code: "DUPLICATE_EXPRESS_ENDPOINT",
        message: `${declaration.endpoint} foi declarado por mais de uma rota Express externa.`,
      });
      continue;
    }
    seen.add(declaration.endpoint);
    if (!(declaration.endpoint in inventory)) {
      violations.push({
        code: "MISSING_EXPRESS_POLICY",
        message: `${declaration.sourceFile}:${declaration.line} (${declaration.endpoint}) não possui política de notificação.`,
      });
    }
  }

  for (const endpoint of Object.keys(inventory)) {
    validateNotificationTargetPolicy(
      endpoint,
      inventory[endpoint],
      allowedPolicies,
      violations,
    );
    if (!seen.has(endpoint)) {
      violations.push({
        code: "UNUSED_EXPRESS_POLICY",
        message: `${endpoint} está no inventário, mas não corresponde a uma rota Express externa montada.`,
      });
    }
  }

  return violations;
}
