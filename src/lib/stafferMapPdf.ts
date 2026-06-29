import { jsPDF } from "jspdf";
import type { StafferMapEntry } from "../types";
import { buildStafferColorMap, STAFFER_MAP_UNASSIGNED, splitLabel } from "./stafferColors";

const MAP_ASPECT = 860 / 920;

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

function drawLegendSwatch(doc: jsPDF, x: number, y: number, color: string, size = 8) {
  const [r, g, b] = hexToRgb(color);
  doc.setFillColor(r, g, b);
  doc.setDrawColor(40, 40, 40);
  doc.rect(x, y - size + 2, size, size, "FD");
}

function addPageIfNeeded(doc: jsPDF, y: number, needed: number, margin: number) {
  const pageHeight = doc.internal.pageSize.getHeight();
  if (y + needed <= pageHeight - margin) return y;
  doc.addPage();
  return margin;
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
  const margin = 40;
  let y = margin;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(18);
  doc.text("TGA Staffer Territories", margin, y);
  y += 22;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(10);
  doc.setTextColor(80, 80, 80);
  const dateLabel = new Date().toLocaleDateString(undefined, { dateStyle: "long" });
  doc.text(
    `${assignedCount} of ${totalCounties} counties assigned · county-based staffers only · ${dateLabel}`,
    margin,
    y
  );
  doc.setTextColor(0, 0, 0);
  y += 24;

  const mapDataUrl = await svgToPngDataUrl(svg);
  const mapWidth = pageWidth - margin * 2;
  const mapHeight = mapWidth * MAP_ASPECT;
  y = addPageIfNeeded(doc, y, mapHeight + 20, margin);
  doc.addImage(mapDataUrl, "PNG", margin, y, mapWidth, mapHeight);
  y += mapHeight + 24;

  y = addPageIfNeeded(doc, y, 30, margin);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Legend", margin, y);
  y += 16;

  doc.setFont("helvetica", "normal");
  doc.setFontSize(9);
  const legendColumnWidth = (pageWidth - margin * 2) / 2;
  const legendLineHeight = 14;

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

  const legendSplit = Math.ceil(legendEntries.length / 2);
  const legendColumns = [
    legendEntries.slice(0, legendSplit),
    legendEntries.slice(legendSplit),
  ];
  const columnYs = [y, y];

  for (let column = 0; column < legendColumns.length; column++) {
    const x = margin + column * legendColumnWidth;
    for (const entry of legendColumns[column]) {
      columnYs[column] = addPageIfNeeded(doc, columnYs[column], legendLineHeight, margin);
      drawLegendSwatch(doc, x, columnYs[column], entry.color);
      doc.text(entry.label, x + 12, columnYs[column]);
      columnYs[column] += legendLineHeight;
    }
  }

  y = Math.max(columnYs[0], columnYs[1]) + 20;
  y = addPageIfNeeded(doc, y, 30, margin);
  doc.setFont("helvetica", "bold");
  doc.setFontSize(12);
  doc.text("Staffer county assignments", margin, y);
  y += 18;

  doc.setFont("helvetica", "bold");
  doc.setFontSize(9);
  doc.text("Staffer", margin, y);
  doc.text("Counties", margin + 150, y);
  y += 12;

  doc.setFont("helvetica", "normal");
  const sortedStaffers = [...staffers].sort((a, b) => a.name.localeCompare(b.name));
  const countiesColumnWidth = pageWidth - margin * 2 - 150;

  for (const staffer of sortedStaffers) {
    const countiesText = staffer.counties.join(", ");
    const countyLines = doc.splitTextToSize(countiesText, countiesColumnWidth) as string[];
    const blockHeight = Math.max(14, countyLines.length * 11 + 2);
    y = addPageIfNeeded(doc, y, blockHeight, margin);

    drawLegendSwatch(doc, margin, y, colorByName.get(staffer.name)!);
    doc.text(staffer.name, margin + 12, y);
    doc.text(countyLines, margin + 150, y);
    y += blockHeight;
  }

  const stamp = new Date().toISOString().slice(0, 10);
  doc.save(`tga-staffer-territories-${stamp}.pdf`);
}
