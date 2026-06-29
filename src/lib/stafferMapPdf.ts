import { jsPDF } from "jspdf";
import type { StafferMapEntry } from "../types";
import { buildStafferColorMap, STAFFER_MAP_UNASSIGNED, splitLabel } from "./stafferColors";

const MAP_ASPECT = 860 / 920;
const MARGIN = 40;
const LEGEND_LINE_HEIGHT = 14;
const LEGEND_SWATCH = 8;
const LEGEND_GAP = 12;

function hexToRgb(hex: string): [number, number, number] {
  const normalized = hex.replace("#", "");
  return [
    parseInt(normalized.slice(0, 2), 16),
    parseInt(normalized.slice(2, 4), 16),
    parseInt(normalized.slice(4, 6), 16),
  ];
}

function prepareSvgForExport(svg: SVGSVGElement): SVGSVGElement {
  const clone = svg.cloneNode(true) as SVGSVGElement;
  clone.setAttribute("xmlns", "http://www.w3.org/2000/svg");
  const viewBox = svg.viewBox.baseVal;
  if (viewBox.width > 0 && viewBox.height > 0) {
    clone.setAttribute("width", String(viewBox.width));
    clone.setAttribute("height", String(viewBox.height));
  }
  return clone;
}

async function svgToPngDataUrl(svg: SVGSVGElement): Promise<string> {
  const exportSvg = prepareSvgForExport(svg);
  const serialized = new XMLSerializer().serializeToString(exportSvg);
  const blob = new Blob([serialized], { type: "image/svg+xml;charset=utf-8" });
  const url = URL.createObjectURL(blob);

  try {
    const image = await new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("Failed to render map for PDF"));
      img.src = url;
    });

    const width = exportSvg.viewBox.baseVal.width || 920;
    const height = exportSvg.viewBox.baseVal.height || 860;
    const scale = 2;
    const canvas = document.createElement("canvas");
    canvas.width = width * scale;
    canvas.height = height * scale;
    const ctx = canvas.getContext("2d");
    if (!ctx) throw new Error("Failed to create map image");

    ctx.scale(scale, scale);
    ctx.fillStyle = "#ffffff";
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(image, 0, 0, width, height);
    return canvas.toDataURL("image/png");
  } finally {
    URL.revokeObjectURL(url);
  }
}

function drawLegendSwatch(doc: jsPDF, x: number, y: number, color: string) {
  const [r, g, b] = hexToRgb(color);
  doc.setFillColor(r, g, b);
  doc.setDrawColor(40, 40, 40);
  doc.rect(x, y - LEGEND_SWATCH + 2, LEGEND_SWATCH, LEGEND_SWATCH, "FD");
}

function pageBottom(doc: jsPDF) {
  return doc.internal.pageSize.getHeight() - MARGIN;
}

function ensureSpace(doc: jsPDF, y: number, needed: number) {
  if (y + needed <= pageBottom(doc)) return y;
  doc.addPage();
  return MARGIN;
}

function legendEntryHeight(doc: jsPDF, label: string, maxLabelWidth: number) {
  const lines = doc.splitTextToSize(label, maxLabelWidth) as string[];
  return Math.max(LEGEND_LINE_HEIGHT, lines.length * 11 + 2);
}

interface LegendLayout {
  leftEntries: { label: string; color: string }[];
  rightEntries: { label: string; color: string }[];
  columnWidth: number;
  labelWidth: number;
  rowCount: number;
  rowHeights: number[];
  totalHeight: number;
}

function measureLegendLayout(
  doc: jsPDF,
  legendEntries: { label: string; color: string }[],
  contentWidth: number
): LegendLayout {
  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);

  const columnWidth = contentWidth / 2;
  const labelWidth = columnWidth - 16;
  const splitAt = Math.ceil(legendEntries.length / 2);
  const leftEntries = legendEntries.slice(0, splitAt);
  const rightEntries = legendEntries.slice(splitAt);
  const rowCount = Math.max(leftEntries.length, rightEntries.length);
  const rowHeights: number[] = [];

  for (let row = 0; row < rowCount; row++) {
    const left = leftEntries[row];
    const right = rightEntries[row];
    rowHeights.push(
      Math.max(
        LEGEND_LINE_HEIGHT,
        left ? legendEntryHeight(doc, left.label, labelWidth) : 0,
        right ? legendEntryHeight(doc, right.label, labelWidth) : 0
      )
    );
  }

  const rowsHeight = rowHeights.reduce((sum, height) => sum + height + 2, 0);
  const totalHeight = 16 + rowsHeight;

  return {
    leftEntries,
    rightEntries,
    columnWidth,
    labelWidth,
    rowCount,
    rowHeights,
    totalHeight,
  };
}

function drawLegendBlock(doc: jsPDF, startY: number, layout: LegendLayout) {
  let y = startY;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(11);
  doc.text("Legend", MARGIN, y);
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);

  for (let row = 0; row < layout.rowCount; row++) {
    const rowHeight = layout.rowHeights[row];
    const left = layout.leftEntries[row];
    const right = layout.rightEntries[row];

    if (left) {
      drawLegendSwatch(doc, MARGIN, y, left.color);
      doc.text(doc.splitTextToSize(left.label, layout.labelWidth) as string[], MARGIN + 12, y);
    }
    if (right) {
      drawLegendSwatch(doc, MARGIN + layout.columnWidth, y, right.color);
      doc.text(
        doc.splitTextToSize(right.label, layout.labelWidth) as string[],
        MARGIN + layout.columnWidth + 12,
        y
      );
    }

    y += rowHeight + 2;
  }

  return y;
}

export async function exportStafferMapPdf(options: {
  staffers: StafferMapEntry[];
  svg: SVGSVGElement;
  assignedCount: number;
  totalCounties: number;
  overlapPairs: { names: string[] }[];
}) {
  const { staffers, svg, assignedCount, totalCounties, overlapPairs } = options;
  const colorByName = buildStafferColorMap(staffers.map((staffer) => staffer.name));
  const doc = new jsPDF({ orientation: "portrait", unit: "pt", format: "letter" });
  const pageWidth = doc.internal.pageSize.getWidth();
  const contentWidth = pageWidth - MARGIN * 2;
  let y = MARGIN;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("TGA Staffer Territories", MARGIN, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  const dateLabel = new Date().toLocaleDateString(undefined, { dateStyle: "long" });
  doc.text(
    `${assignedCount} of ${totalCounties} counties assigned · county-based staffers only · ${dateLabel}`,
    MARGIN,
    y
  );
  doc.setTextColor(0, 0, 0);
  y += 20;

  const legendEntries: { label: string; color: string }[] = [
    ...staffers.map((staffer) => ({
      label: staffer.name,
      color: colorByName.get(staffer.name)!,
    })),
    ...overlapPairs.map(({ names }) => ({
      label: splitLabel(names),
      color: colorByName.get(names[0])!,
    })),
    { label: "Unassigned", color: STAFFER_MAP_UNASSIGNED },
  ];

  const legendLayout = measureLegendLayout(doc, legendEntries, contentWidth);
  const mapDataUrl = await svgToPngDataUrl(svg);
  const maxMapHeight = pageBottom(doc) - y - legendLayout.totalHeight - LEGEND_GAP;
  let mapWidth = contentWidth;
  let mapHeight = mapWidth * MAP_ASPECT;

  if (mapHeight > maxMapHeight) {
    mapHeight = Math.max(120, maxMapHeight);
    mapWidth = mapHeight / MAP_ASPECT;
  }
  if (mapWidth > contentWidth) {
    mapWidth = contentWidth;
    mapHeight = mapWidth * MAP_ASPECT;
  }

  const mapX = MARGIN + (contentWidth - mapWidth) / 2;
  doc.addImage(mapDataUrl, "PNG", mapX, y, mapWidth, mapHeight);
  y += mapHeight + LEGEND_GAP;
  drawLegendBlock(doc, y, legendLayout);

  doc.addPage();
  y = MARGIN;
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Staffer county assignments", MARGIN, y);
  y += 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Staffer", MARGIN, y);
  doc.text("Counties", MARGIN + 150, y);
  y += 12;

  doc.setFont("helvetica", "normal");
  const sortedStaffers = [...staffers].sort((a, b) => a.name.localeCompare(b.name));
  const countiesColumnWidth = contentWidth - 150;

  for (const staffer of sortedStaffers) {
    const countyLines = doc.splitTextToSize(staffer.counties.join(", "), countiesColumnWidth) as string[];
    const blockHeight = Math.max(LEGEND_LINE_HEIGHT, countyLines.length * 11 + 2);
    y = ensureSpace(doc, y, blockHeight);

    drawLegendSwatch(doc, MARGIN, y, colorByName.get(staffer.name)!);
    doc.text(staffer.name, MARGIN + 12, y);
    doc.text(countyLines, MARGIN + 150, y);
    y += blockHeight;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`tga-staffer-territories-${stamp}.pdf`);
}
