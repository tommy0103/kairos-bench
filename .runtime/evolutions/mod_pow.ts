import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

interface ModPowResult {
  result: string;
}

export function createModPowTool(): AgentTool<any, ModPowResult> {
  return {
    name: "mod_pow",
    label: "模幂运算",
    description: "计算大数模幂 a^b mod m",
    parameters: Type.Object({
      base: Type.String({ description: "底数" }),
      exponent: Type.String({ description: "指数" }),
      modulus: Type.String({ description: "模数" }),
    }),
    execute: async (_toolCallId, params) => {
      const base = BigInt(params.base);
      const exp = BigInt(params.exponent);
      const mod = BigInt(params.modulus);
      
      // 快速幂算法
      function modPow(b: bigint, e: bigint, m: bigint): bigint {
        let result = 1n;
        b = b % m;
        while (e > 0n) {
          if (e % 2n === 1n) {
            result = (result * b) % m;
          }
          e = e / 2n;
          b = (b * b) % m;
        }
        return result;
      }
      
      const result = modPow(base, exp, mod);
      
      return {
        content: [{ type: "text", text: result.toString() }],
        details: { result: result.toString() },
      };
    },
  };
}