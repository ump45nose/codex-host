import { findReactProps } from "./react-fiber-props.js";

/** Codex colors each remote host's globe through this variable on the sidebar project icon. */
const GLOBE_COLOR_VARIABLE = "--remote-host-globe-color";
const REMOTE_PROJECT_SELECTOR = '[data-sidebar-project-kind="remote"]';
/** The globe from Codex's remote project icon, cropped to its own bounds. */
const GLOBE_VIEW_BOX = "8.03 8.79 6.6 6.6";
const GLOBE_PATH =
  "M11.3341 8.99774C13.0412 8.99817 14.4259 10.3823 14.4259 12.0895C14.4257 13.7967 13.0403 15.1802 11.3331 15.1804C9.62649 15.1796 8.24255 13.7963 8.24231 12.0895C8.24231 10.3821 9.62663 8.99774 11.3341 8.99774ZM10.88 12.53C10.9107 13.0499 10.9942 13.5041 11.1066 13.8405C11.1789 14.0567 11.2559 14.2013 11.3204 14.2829C11.3244 14.2878 11.3296 14.2914 11.3331 14.2956C11.3368 14.2913 11.3427 14.2881 11.3468 14.2829C11.4113 14.2012 11.4884 14.0568 11.5607 13.8405C11.6731 13.5041 11.7556 13.0499 11.7863 12.53H10.88ZM9.13489 12.53C9.2686 13.2 9.70172 13.7611 10.2882 14.071C10.1507 13.6447 10.0609 13.1116 10.0304 12.53H9.13489ZM12.6368 12.53C12.6061 13.1117 12.5146 13.6446 12.3771 14.071C12.964 13.7613 13.3976 13.2005 13.5314 12.53H12.6368ZM10.2882 10.1061C9.69233 10.421 9.25628 10.9962 9.13 11.6804H10.0284C10.0573 11.0859 10.1481 10.5404 10.2882 10.1061ZM11.3204 9.8952C11.2559 9.97691 11.1789 10.1221 11.1066 10.3386C10.9919 10.6818 10.9081 11.1473 10.879 11.6804H11.7872C11.7581 11.1474 11.6753 10.6818 11.5607 10.3386C11.4884 10.1223 11.4113 9.97695 11.3468 9.8952C11.3425 9.88982 11.3369 9.88594 11.3331 9.88153C11.3294 9.88589 11.3246 9.88996 11.3204 9.8952ZM12.3771 10.1052C12.5175 10.5396 12.6087 11.0853 12.6378 11.6804H13.5363C13.4099 10.9956 12.9736 10.4198 12.3771 10.1052Z";

export interface SidebarRemoteProject {
  readonly hostId: string;
  readonly hostDisplayName: string;
  readonly projectId: string;
  readonly label: string;
  readonly path: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

/** Remote projects in sidebar order, read from each project row's native `group` prop. */
export function collectSidebarRemoteProjects(doc: Document): SidebarRemoteProject[] {
  const projects = new Map<string, SidebarRemoteProject>();
  for (const row of doc.querySelectorAll(
    `${REMOTE_PROJECT_SELECTOR} [data-app-action-sidebar-project-row]`,
  )) {
    const group = findReactProps(row, (props) => (isRecord(props.group) ? props.group : null));
    if (
      !group ||
      group.projectKind !== "remote" ||
      typeof group.hostId !== "string" ||
      typeof group.projectId !== "string" ||
      typeof group.path !== "string" ||
      !group.path
    )
      continue;
    const key = `${group.hostId}\n${group.projectId}`;
    if (projects.has(key)) continue;
    projects.set(key, {
      hostId: group.hostId,
      hostDisplayName: typeof group.hostDisplayName === "string" ? group.hostDisplayName : "",
      projectId: group.projectId,
      label: typeof group.label === "string" && group.label ? group.label : group.path,
      path: group.path,
    });
  }
  return [...projects.values()];
}

/** Remote host → globe color, read from the sidebar's remote project icons. */
export function readRemoteHostGlobeColors(doc: Document): Map<string, string> {
  const colors = new Map<string, string>();
  for (const svg of doc.querySelectorAll<SVGElement>(
    `${REMOTE_PROJECT_SELECTOR} svg[style*="${GLOBE_COLOR_VARIABLE}"]`,
  )) {
    const color = svg.style.getPropertyValue(GLOBE_COLOR_VARIABLE).trim();
    const hostId = findReactProps(svg, (props) =>
      typeof props.hostId === "string" ? props.hostId : null,
    );
    if (color && hostId && !colors.has(hostId)) colors.set(hostId, color);
  }
  return colors;
}

/** Codex's remote host globe in the host's color, or the current text color when unknown. */
export function createRemoteHostGlobe(
  doc: Document,
  color: string | null,
  className: string,
): SVGSVGElement {
  const ns = "http://www.w3.org/2000/svg";
  const svg = doc.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", GLOBE_VIEW_BOX);
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const path = doc.createElementNS(ns, "path");
  path.setAttribute("fill-rule", "evenodd");
  path.setAttribute("clip-rule", "evenodd");
  path.setAttribute("d", GLOBE_PATH);
  path.setAttribute("fill", color ?? "currentColor");
  svg.appendChild(path);
  return svg;
}
