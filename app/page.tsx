import { DefaultDemo, CustomColorDemo } from "@/components/ui/expandable-tabs-demo";

export default function Home() {
  return (
    <main className="flex min-h-screen flex-col items-center justify-center gap-8 p-24">
      <h1 className="text-2xl font-bold">Expandable Tabs Demo</h1>
      <DefaultDemo />
      <CustomColorDemo />
    </main>
  );
}
