import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

export function createModExpTool(): AgentTool<any, any> {
  return {
    name: "mod_exp",
    label: "模幂运算",
    description: "计算大数的模幂运算 (base^exponent) mod modulus",
    parameters: Type.Object({
      base: Type.String({ description: "底数" }),
      exponent: Type.String({ description: "指数" }),
      modulus: Type.String({ description: "模数" }),
    }),
    execute: async (_toolCallId, params) => {
      const { base, exponent, modulus } = params;
      
      // 快速幂算法 (二进制幂)
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
      
      const b = BigInt(base);
      const e = BigInt(exponent);
      const m = BigInt(modulus);
      
      const result = modPow(b, e, m);
      
      return {
        content: [{ type: "text", text: result.toString() }],
        details: { ok: true },
      };
    },
  };
}