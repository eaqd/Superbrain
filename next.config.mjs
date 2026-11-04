/** @type {import('next').NextConfig} */
const nextConfig = {
  async rewrites() {
    // Faith Theory lab is a static page in public/faith/
    return [{ source: "/faith", destination: "/faith/index.html" }];
  },
};

export default nextConfig;
