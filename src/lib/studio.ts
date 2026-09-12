export type StudioBlockId = "intro" | "steps" | "benefits" | "tariffs";

export type StudioConfig = {
  operations: {
    venueName: string;
    address: string;
    opensAt: string;
    closesAt: string;
    horizonDays: number;
    maxDurationHours: number;
    morningPriceCents: number;
    eveningPriceCents: number;
    eveningStartsAt: string;
  };
  content: {
    eyebrow: string;
    headline: string;
    benefits: string[];
    termsLabel: string;
    paymentNote: string;
  };
  design: {
    primary: string;
    accent: string;
    surface: string;
    background: string;
    text: string;
    radius: number;
    buttonStyle: "rounded" | "pill" | "square";
  };
  blocks: { id: StudioBlockId; visible: boolean }[];
};

export const defaultStudioConfig: StudioConfig = {
  operations: {
    venueName: "Volta Pong",
    address: "Voltastrasse 30 · Basel",
    opensAt: "09:00",
    closesAt: "00:00",
    horizonDays: 120,
    maxDurationHours: 3,
    morningPriceCents: 1800,
    eveningPriceCents: 2200,
    eveningStartsAt: "16:00",
  },
  content: {
    eyebrow: "Tisch buchen",
    headline: "Wann wollt ihr spielen?",
    benefits: ["Schläger & Bälle inklusive", "Tisch wird automatisch zugeteilt"],
    termsLabel: "Ich akzeptiere die Buchungs- und Stornobedingungen.",
    paymentNote: "Sicherer SumUp-Testcheckout · Es wird kein echtes Geld belastet. Dein Tisch bleibt 30 Minuten reserviert.",
  },
  design: {
    primary: "#144e94",
    accent: "#fd2e02",
    surface: "#ffffff",
    background: "#f5e3e4",
    text: "#15304e",
    radius: 28,
    buttonStyle: "rounded",
  },
  blocks: [
    { id: "intro", visible: true },
    { id: "steps", visible: true },
    { id: "benefits", visible: true },
    { id: "tariffs", visible: true },
  ],
};

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function mergeStudioConfig(raw: unknown): StudioConfig {
  const root = object(raw), operations = object(root.operations), content = object(root.content), design = object(root.design);
  const blockIds: StudioBlockId[] = ["intro", "steps", "benefits", "tariffs"];
  const blocks = Array.isArray(root.blocks)
    ? root.blocks.flatMap((value) => {
        const block = object(value), id = block.id as StudioBlockId;
        return blockIds.includes(id) ? [{ id, visible: block.visible !== false }] : [];
      })
    : [];
  for (const id of blockIds) if (!blocks.some((block) => block.id === id)) blocks.push({ id, visible: true });
  return {
    operations: { ...defaultStudioConfig.operations, ...operations } as StudioConfig["operations"],
    content: {
      ...defaultStudioConfig.content,
      ...content,
      benefits: Array.isArray(content.benefits) ? content.benefits.slice(0, 4).map(String) : defaultStudioConfig.content.benefits,
    } as StudioConfig["content"],
    design: { ...defaultStudioConfig.design, ...design } as StudioConfig["design"],
    blocks,
  };
}

export const studioBlockLabels: Record<StudioBlockId, { title: string; hint: string }> = {
  intro: { title: "Einstieg", hint: "Kicker und grosse Überschrift" },
  steps: { title: "Ablauf", hint: "Vier Schritte der Buchung" },
  benefits: { title: "Vorteile", hint: "Kurze Vertrauensargumente" },
  tariffs: { title: "Preisübersicht", hint: "Vormittags- und Abendtarif" },
};
