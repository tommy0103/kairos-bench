import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

interface HighPrecisionMultiplyDetails {
  result: string;
}

export function createHighPrecisionMultiplyTool(): AgentTool<any, HighPrecisionMultiplyDetails> {
  return {
    name: "high_precision_multiply",
    label: "高精度乘法",
    description: "计算两个任意精度数字的乘积 a * b，支持整数和小数",
    parameters: Type.Object({
      a: Type.String({ description: "第一个乘数（数字字符串）" }),
      b: Type.String({ description: "第二个乘数（数字字符串）" }),
    }),
    execute: async (_toolCallId, params): Promise<{ content: Array<{ type: "text"; text: string }>; details: HighPrecisionMultiplyDetails }> => {
      const { a, b } = params;
      
      // 高精度乘法实现
      function multiply(num1: string, num2: string): string {
        // 处理符号
        const isNegative1 = num1.startsWith('-');
        const isNegative2 = num2.startsWith('-');
        const isNegative = isNegative1 !== isNegative2;
        
        num1 = num1.replace(/^-/, '');
        num2 = num2.replace(/^-/, '');
        
        // 处理小数点
        const decimal1 = num1.includes('.') ? num1.split('.')[1].length : 0;
        const decimal2 = num2.includes('.') ? num2.split('.')[1].length : 0;
        const totalDecimal = decimal1 + decimal2;
        
        num1 = num1.replace('.', '');
        num2 = num2.replace('.', '');
        
        // 去除前导零
        num1 = num1.replace(/^0+/, '') || '0';
        num2 = num2.replace(/^0+/, '') || '0';
        
        if (num1 === '0' || num2 === '0') {
          return '0';
        }
        
        // 逐位相乘
        const result: number[] = new Array(num1.length + num2.length).fill(0);
        
        for (let i = num1.length - 1; i >= 0; i--) {
          for (let j = num2.length - 1; j >= 0; j--) {
            const product = parseInt(num1[i]) * parseInt(num2[j]);
            const sum = product + result[i + j + 1];
            result[i + j + 1] = sum % 10;
            result[i + j] += Math.floor(sum / 10);
          }
        }
        
        // 转换为字符串
        let resultStr = result.join('').replace(/^0+/, '') || '0';
        
        // 添加小数点
        if (totalDecimal > 0) {
          if (resultStr.length <= totalDecimal) {
            resultStr = '0.' + '0'.repeat(totalDecimal - resultStr.length) + resultStr;
          } else {
            const insertPos = resultStr.length - totalDecimal;
            resultStr = resultStr.slice(0, insertPos) + '.' + resultStr.slice(insertPos);
          }
          // 去除末尾的零
          resultStr = resultStr.replace(/\.?0+$/, '');
          if (resultStr.endsWith('.')) {
            resultStr = resultStr.slice(0, -1);
          }
        }
        
        return isNegative ? '-' + resultStr : resultStr;
      }
      
      const result = multiply(a, b);
      
      return {
        content: [{ type: "text", text: `${a} × ${b} = ${result}` }],
        details: { result },
      };
    },
  };
}
