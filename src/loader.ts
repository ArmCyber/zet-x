interface ResolveContext {
  conditions?: string[];
  parentURL?: string;
}

interface ResolveResult {
  url: string;
  shortCircuit?: boolean;
}

type NextResolve = (specifier: string, context: ResolveContext) => ResolveResult;

export function resolve(specifier: string, context: ResolveContext, nextResolve: NextResolve): ResolveResult {
  if (specifier === "zet-x") {
    return {
      url: new URL("./index.js", import.meta.url).href,
      shortCircuit: true,
    };
  }
  return nextResolve(specifier, context);
}
