import { ServiceTraceExplorer } from "@/components/service-trace/service-trace-explorer";

export default async function ServiceTracePage({ searchParams }: { searchParams?: Promise<{ service?: string }> }) {
  const params = await searchParams;
  const initialService = params?.service?.trim() ?? "";
  return <ServiceTraceExplorer initialTrace={null} initialService={initialService} />;
}
