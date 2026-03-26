import type {
  AnalysisResult,
  BugReport,
  ObjectModelReport,
  TimelineReport,
} from "@/lib/types";

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function formatTime(sec: number) {
  const whole = Math.max(0, Math.floor(sec));
  const seconds = whole % 60;
  const minutes = Math.floor(whole / 60) % 60;
  const hours = Math.floor(whole / 3600);
  const pad = (value: number) => value.toString().padStart(2, "0");
  return hours > 0
    ? `${hours}:${pad(minutes)}:${pad(seconds)}`
    : `${minutes}:${pad(seconds)}`;
}

export function buildReports(analysis: Omit<AnalysisResult, "reports">) {
  const ticketMoments = analysis.moments.filter(
    (moment) => moment.category === "bug" || moment.category === "frustration",
  );

  const bugReport: BugReport = {
    summary:
      ticketMoments.length > 0
        ? `Detected ${ticketMoments.length} bug or frustration moments worth ticketing.`
        : "No clear bugs or frustration moments were detected.",
    tickets: ticketMoments.map((moment) => ({
      title: moment.suggestedTicketTitle ?? moment.title,
      severity: moment.severity,
      summary: moment.summary,
      reproductionContext: `${formatTime(moment.startSec)} to ${formatTime(
        moment.endSec,
      )}${moment.quote ? `; quote: "${moment.quote}"` : ""}`,
      evidence: moment.evidence,
      acceptanceCriteria:
        moment.acceptanceCriteria.length > 0
          ? moment.acceptanceCriteria
          : ["The flow should complete without confusion or visible failure."],
    })),
  };

  const objectModelReport: ObjectModelReport = {
    summary:
      analysis.entities.length > 0
        ? `Mapped ${analysis.entities.length} visible or inferred objects and ${analysis.relationships.length} relationships.`
        : "No stable object model could be inferred from the current evidence.",
    objects: analysis.entities,
    relationships: analysis.relationships,
    unknowns:
      analysis.entities.length === 0
        ? ["The walkthrough did not expose enough stable UI state to model objects."]
        : [],
  };

  const timelineReport: TimelineReport = {
    summary:
      analysis.flowSteps.length > 0
        ? `The walkthrough covered ${analysis.flowSteps.length} major flow steps.`
        : "No meaningful flow steps were inferred.",
    highlights: analysis.flowSteps.map(
      (step) =>
        `${formatTime(step.startSec)}-${formatTime(step.endSec)}: ${step.title} - ${step.summary}`,
    ),
  };

  return {
    bugReport,
    objectModelReport,
    timelineReport,
  };
}

function renderList(items: string[]) {
  if (items.length === 0) return "<p>None.</p>";
  return `<ul>${items.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}</ul>`;
}

export function renderBugReportHtml(report: BugReport) {
  return `
    <section>
      <h2>Bug Ticket Report</h2>
      <p>${escapeHtml(report.summary)}</p>
      ${report.tickets
        .map(
          (ticket) => `
            <article>
              <h3>${escapeHtml(ticket.title)}</h3>
              <p><strong>Severity:</strong> ${escapeHtml(ticket.severity)}</p>
              <p>${escapeHtml(ticket.summary)}</p>
              <p><strong>Context:</strong> ${escapeHtml(ticket.reproductionContext)}</p>
              <h4>Evidence</h4>
              ${renderList(ticket.evidence)}
              <h4>Acceptance Criteria</h4>
              ${renderList(ticket.acceptanceCriteria)}
            </article>
          `,
        )
        .join("")}
    </section>
  `;
}

export function renderObjectModelReportHtml(report: ObjectModelReport) {
  return `
    <section>
      <h2>Object Model Report</h2>
      <p>${escapeHtml(report.summary)}</p>
      <h3>Objects</h3>
      ${report.objects
        .map(
          (entity) => `
            <article>
              <h4>${escapeHtml(entity.name)} <small>(${escapeHtml(
                entity.entityType,
              )})</small></h4>
              <p>${escapeHtml(entity.description)}</p>
            </article>
          `,
        )
        .join("") || "<p>No objects detected.</p>"}
      <h3>Relationships</h3>
      ${report.relationships
        .map(
          (relationship) => `
            <p><strong>${escapeHtml(relationship.fromEntity)}</strong> ${escapeHtml(
              relationship.relationshipType,
            )} <strong>${escapeHtml(relationship.toEntity)}</strong> - ${escapeHtml(
              relationship.description,
            )}</p>
          `,
        )
        .join("") || "<p>No relationships detected.</p>"}
      <h3>Unknowns</h3>
      ${renderList(report.unknowns)}
    </section>
  `;
}

export function renderTimelineReportHtml(report: TimelineReport) {
  return `
    <section>
      <h2>Timeline Report</h2>
      <p>${escapeHtml(report.summary)}</p>
      ${renderList(report.highlights)}
    </section>
  `;
}
