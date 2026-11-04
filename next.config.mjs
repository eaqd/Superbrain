/** @type {import('next').NextConfig} */
const nextConfig = {
  async redirects() {
    // The Faith Theory lab is a static page in public/faith/ (it loads
    // engine.js and results.js from the same folder).
    return [{ source: "/faith", destination: "/faith/index.html", permanent: false }];
  },
};

export default nextConfig;
