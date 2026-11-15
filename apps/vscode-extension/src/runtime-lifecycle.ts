export type RuntimeUpgrade = { pid: number; from: string; to: string };

export function runtimeUpgradePlan(serialized: string, expectedVersion: string): RuntimeUpgrade | undefined {
    try {
        const instance = JSON.parse(serialized) as Record<string, unknown>;
        const pid = Number(instance.pid);
        const port = Number(instance.port);
        const version = typeof instance.version === "string" ? instance.version : "";
        if (!Number.isSafeInteger(pid) || pid <= 1 || !Number.isInteger(port) || port < 1 || port > 65535 || !version || !expectedVersion || version === expectedVersion)
            return undefined;
        return { pid, from: version, to: expectedVersion };
    }
    catch {
        return undefined;
    }
}
