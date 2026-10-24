/**
 *                        WHITEBOPHIR
 *********************************************************
 * @licstart  The following is the entire license notice for the
 *  JavaScript code in this page.
 *
 * Copyright (C) 2020  Ophir LOJKINE
 *
 *
 * The JavaScript code in this page is free software: you can
 * redistribute it and/or modify it under the terms of the GNU
 * General Public License (GNU GPL) as published by the Free Software
 * Foundation, either version 3 of the License, or (at your option)
 * any later version.  The code is distributed WITHOUT ANY WARRANTY;
 * without even the implied warranty of MERCHANTABILITY or FITNESS
 * FOR A PARTICULAR PURPOSE.  See the GNU GPL for more details.
 *
 * As additional permission under GNU GPL version 3 section 7, you
 * may distribute non-source (e.g., minimized or compacted) forms of
 * that code without the copy of the GNU GPL normally required by
 * section 4, provided you include this license notice and a URL
 * through which recipients can access the Corresponding Source.
 *
 * @licend
 */

/** @import { ToolBootContext } from "../../../types/app-runtime" */
/** @typedef {ReturnType<typeof boot>} DownloadToolState */

import { DEFAULT_BOARD_SCALE } from "../../js/board_viewport.js";

export const toolId = "download";
export const shortcut = "d";
export const oneTouch = true;
export const mouseCursor = "crosshair";
export const visibleWhenReadOnly = true;

const EXPORT_PADDING_PX = 24;

/**
 * Fits a standalone download to the actual drawing instead of exporting the
 * complete 655360-unit collaboration surface. The latter is a coordinate
 * safety boundary, not a useful document page size.
 * @param {SVGSVGElement} source
 * @param {SVGSVGElement} target
 */
function fitExportToDrawing(source, target) {
  const drawingArea = source.querySelector("#drawingArea");
  if (!(drawingArea instanceof SVGGraphicsElement)) return;

  let bounds;
  try {
    bounds = drawingArea.getBBox();
  } catch {
    return;
  }
  if (
    !Number.isFinite(bounds.x) ||
    !Number.isFinite(bounds.y) ||
    !Number.isFinite(bounds.width) ||
    !Number.isFinite(bounds.height) ||
    (bounds.width === 0 && bounds.height === 0)
  ) {
    return;
  }

  const padding = EXPORT_PADDING_PX / DEFAULT_BOARD_SCALE;
  const minX = Math.floor(bounds.x - padding);
  const minY = Math.floor(bounds.y - padding);
  const viewBoxWidth = Math.max(1, Math.ceil(bounds.width + padding * 2));
  const viewBoxHeight = Math.max(1, Math.ceil(bounds.height + padding * 2));
  const width = Math.max(1, Math.ceil(viewBoxWidth * DEFAULT_BOARD_SCALE));
  const height = Math.max(1, Math.ceil(viewBoxHeight * DEFAULT_BOARD_SCALE));
  target.setAttribute(
    "viewBox",
    `${minX} ${minY} ${viewBoxWidth} ${viewBoxHeight}`,
  );
  target.setAttribute("width", String(width));
  target.setAttribute("height", String(height));
}

/**
 * @param {Blob} blob
 * @param {string} filename
 */
function downloadContent(blob, filename) {
  const url = URL.createObjectURL(blob);
  const element = document.createElement("a");
  element.setAttribute("href", url);
  element.setAttribute("download", filename);
  element.style.display = "none";
  document.body.appendChild(element);
  element.click();
  document.body.removeChild(element);
  window.URL.revokeObjectURL(url);
}

/** @param {DownloadToolState} state */
function downloadSvgFile(state) {
  const canvasCopy = /** @type {SVGSVGElement} */ (
    state.board.svg.cloneNode(true)
  );
  fitExportToDrawing(state.board.svg, canvasCopy);
  canvasCopy.removeAttribute("style");
  const styleNode = document.createElement("style");
  styleNode.innerHTML = Array.from(document.styleSheets)
    .filter(
      (stylesheet) =>
        !!(
          stylesheet.href &&
          (stylesheet.href.match(/\/tools\/.*\.css/) ||
            stylesheet.href.match(/board\.css/))
        ),
    )
    .map((stylesheet) =>
      Array.from(stylesheet.cssRules).map((rule) => rule.cssText),
    )
    .join("\n");
  canvasCopy.appendChild(styleNode);
  const outerHTML =
    canvasCopy.outerHTML || new XMLSerializer().serializeToString(canvasCopy);
  downloadContent(
    new Blob([outerHTML], { type: "image/svg+xml;charset=utf-8" }),
    `${state.identity.boardName}.svg`,
  );
}

/** @param {ToolBootContext} ctx */
export function boot(ctx) {
  return {
    board: ctx.runtime.board,
    identity: ctx.runtime.identity,
  };
}

/** @param {DownloadToolState} state */
export function onstart(state) {
  downloadSvgFile(state);
}

export function draw() {}
