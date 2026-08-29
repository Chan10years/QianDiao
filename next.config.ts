import type { NextConfig } from "next";

// 手机真机局域网联调时通过 .env.local 配置，多个来源用英文逗号分隔。
// 例：MOBILE_DEV_ORIGINS=10.64.211.77 或 MOBILE_DEV_ORIGINS=192.168.1.5:3000
const mobileDevOrigins = (process.env.MOBILE_DEV_ORIGINS ?? "")
  .split(",")
  .map((origin) => origin.trim())
  .filter((origin) => origin.length > 0);

const nextConfig: NextConfig = {
  ...(mobileDevOrigins.length > 0 ? { allowedDevOrigins: mobileDevOrigins } : {}),
};

export default nextConfig;
