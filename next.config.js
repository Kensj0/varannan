/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Ren statisk export — ingen Cloud Run/SSR-backend behövs, vilket gör
  // `firebase deploy --only hosting` till en enkel filuppladdning (sekunder)
  // istället för en container-byggd Cloud Functions-deploy (minuter).
  // Kräver att inga sidor använder server-only-funktioner (cookies(),
  // headers(), Route Handlers med `dynamic = "force-dynamic"`, osv).
  output: "export",
};

module.exports = nextConfig;