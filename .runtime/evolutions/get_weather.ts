import { Type } from "@mariozechner/pi-ai";
import type { AgentTool } from "@mariozechner/pi-agent-core";

interface WeatherResponse {
  city: string;
  temp: number;
  condition: string;
  humidity?: number;
  wind?: string;
}

interface WeatherDetails {
  success: boolean;
  data?: WeatherResponse;
  error?: string;
}

export function createWeatherTool(): AgentTool<any, WeatherDetails> {
  return {
    name: "get_weather",
    label: "Get Weather",
    description: "获取指定城市的当前天气信息",
    parameters: Type.Object({
      city: Type.String({ description: "城市名称，例如：天津、北京、上海" }),
    }),
    execute: async (_toolCallId, params) => {
      const { city } = params;
      
      try {
        // 使用 wttr.in 获取天气数据
        const response = await fetch(`https://wttr.in/${encodeURIComponent(city)}?format=j1`, {
          headers: {
            "Accept": "application/json"
          }
        });
        
        if (!response.ok) {
          throw new Error(`Weather API error: ${response.status}`);
        }
        
        const data = await response.json();
        
        const current = data.current_condition?.[0];
        if (!current) {
          throw new Error("No weather data found");
        }
        
        const weatherData: WeatherResponse = {
          city: data.nearest_area?.[0]?.areaName?.[0]?.value || city,
          temp: parseInt(current.temp_C),
          condition: current.lang_zh?.[0]?.value || current.weatherDesc?.[0]?.value || "未知",
          humidity: parseInt(current.humidity),
          wind: `${current.winddir16Point} ${current.windspeedKmph}km/h`
        };
        
        return {
          content: [{ type: "text", text: `${weatherData.city}：${weatherData.temp}°C，${weatherData.condition}，湿度${weatherData.humidity}%，风力${weatherData.wind}` }],
          details: { success: true, data: weatherData }
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        return {
          content: [{ type: "text", text: `...查天气时出了点问题。${errorMsg}` }],
          details: { success: false, error: errorMsg }
        };
      }
    },
  };
}