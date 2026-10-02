declare module "plotly.js-basic-dist" {
  interface PlotlyStatic {
    newPlot(el: HTMLElement, data: unknown[], layout?: object, config?: object): Promise<void>;
    purge(el: HTMLElement): void;
  }
  const Plotly: PlotlyStatic;
  export default Plotly;
}
