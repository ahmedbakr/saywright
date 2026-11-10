export function nodeSupported(version?: string): boolean;
export function nodeMessage(version?: string): string;
export function proxyVariables(env?: Record<string, string | undefined>): string[];
export function envProxySupported(version?: string): boolean;
export function noProxyWithLocal(env?: Record<string, string | undefined>): string;
export function withEnvProxy(args: string[], log?: (line: string) => void): Promise<number | null>;
