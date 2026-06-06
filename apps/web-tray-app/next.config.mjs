/** @type {import('next').NextConfig} */
const nextConfig = {
  output: "standalone",
  turbopack: {},
  transpilePackages: ["@note/editor", "@note/file-browser", "@note/types", "@note/utils"],
};

export default nextConfig;
