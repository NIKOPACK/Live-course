'use client';

/**
 * PBL v2 — replay/presentation surface.
 *
 * A replay is a presentation of the persisted project, not a second teaching
 * session.  Keep this component intentionally separate from the workspace:
 * it has no callbacks, effects, network requests, or form controls.  That
 * separation is the read-only boundary; adding a new workspace interaction
 * cannot accidentally make replay writable unless it is explicitly added here.
 */

import type { ReactNode } from 'react';
import type {
  PBLEvaluation,
  PBLMilestone,
  PBLMicrotask,
  PBLProjectV2,
  PBLSubmission,
} from '@/lib/pbl/v2/types';
import { trimmedPBLText } from '@/lib/pbl/v2/readers';
import { useI18n } from '@/lib/hooks/use-i18n';

interface Props {
  readonly project: PBLProjectV2;
}

type Translate = (key: string, options?: Record<string, unknown>) => string;

function normalizedStatus(status: string): string {
  return status.toLowerCase().replaceAll(' ', '_');
}

function statusLabel(status: string, t: Translate): string {
  switch (normalizedStatus(status)) {
    case 'completed':
      return t('livecourse.entryStatusCompleted');
    case 'active':
    case 'in_progress':
      return t('livecourse.entryStatusInProgress');
    case 'todo':
      return t('actions.status.inputStreaming');
    case 'locked':
      return t('actions.status.outputDenied');
    case 'skipped':
      return t('proactiveCard.skip');
    default:
      return status;
  }
}

function statusTone(status: string): string {
  switch (status) {
    case 'completed':
      return 'border-emerald-300/25 bg-emerald-400/10 text-emerald-100';
    case 'active':
    case 'in_progress':
      return 'border-cyan-300/25 bg-cyan-400/10 text-cyan-100';
    case 'locked':
      return 'border-white/10 bg-white/[0.03] text-slate-400';
    case 'skipped':
      return 'border-amber-300/20 bg-amber-400/10 text-amber-100';
    default:
      return 'border-white/10 bg-white/[0.04] text-slate-300';
  }
}

function projectStatus(project: PBLProjectV2): string {
  if (project.status === 'completed' || project.uiPhase === 'completed') return 'completed';
  if (project.status === 'archived') return 'archived';
  return 'active';
}

function sortByOrder<T extends { order: number }>(items: readonly T[]): T[] {
  return [...items].sort((a, b) => a.order - b.order);
}

function completedTaskCount(milestones: readonly PBLMilestone[]): number {
  return milestones.reduce(
    (count, milestone) =>
      count + milestone.microtasks.filter((task) => task.status === 'completed').length,
    0,
  );
}

function totalTaskCount(milestones: readonly PBLMilestone[]): number {
  return milestones.reduce((count, milestone) => count + milestone.microtasks.length, 0);
}

function latestEvaluation(evaluations: readonly PBLEvaluation[]): PBLEvaluation | undefined {
  // Prefer a final report when one exists; while a project is in progress,
  // retain the most recent persisted task or milestone feedback.
  return (
    evaluations.filter((evaluation) => evaluation.kind === 'final').at(-1) ?? evaluations.at(-1)
  );
}

function allMessages(project: PBLProjectV2) {
  return project.threads
    .flatMap((thread) => thread.messages)
    .filter((message) => trimmedPBLText(message.content).length > 0)
    .sort((a, b) => a.ts.localeCompare(b.ts));
}

function textOrNull(value: unknown): string | undefined {
  const text = trimmedPBLText(value);
  return text || undefined;
}

function shortText(value: unknown, max = 700): string | undefined {
  const text = textOrNull(value);
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max).trimEnd()}…` : text;
}

export function PBLPresentationView({ project }: Props) {
  const { t } = useI18n();
  const milestones = sortByOrder(project.milestones);
  const totalTasks = totalTaskCount(milestones);
  const completedTasks = completedTaskCount(milestones);
  const instructor = project.roles.find((role) => role.type === 'instructor');
  const evaluation = latestEvaluation(project.evaluations);
  const messages = allMessages(project);
  const submissions = project.submissions;

  return (
    <div
      className="h-full w-full overflow-y-auto bg-[radial-gradient(circle_at_15%_0%,rgba(124,92,255,0.18),transparent_34%),linear-gradient(160deg,#0d1729_0%,#111c33_52%,#0b1324_100%)] text-slate-100"
      aria-readonly="true"
      data-pbl-presentation-only="true"
    >
      <div className="mx-auto w-full max-w-5xl space-y-4 px-5 py-6 sm:px-8 sm:py-8">
        <header className="rounded-2xl border border-white/[0.10] bg-white/[0.055] p-5 shadow-[0_12px_40px_rgba(0,0,0,0.18)]">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0">
              <p className="text-[10px] font-semibold uppercase tracking-[0.18em] text-cyan-200/75">
                {t('pbl.v2.hero.title')}
              </p>
              <h1 className="mt-2 text-2xl font-bold tracking-tight text-white sm:text-3xl">
                {textOrNull(project.title) ?? 'Project'}
              </h1>
              {textOrNull(project.description) && (
                <p className="mt-2 max-w-3xl whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
                  {shortText(project.description, 1000)}
                </p>
              )}
            </div>
            <StatusBadge
              status={projectStatus(project)}
              label={statusLabel(projectStatus(project), t)}
            />
          </div>

          <div className="mt-4 flex flex-wrap gap-2 text-xs text-slate-300">
            <SummaryPill label={t('pbl.v2.hero.stage')} value={String(milestones.length)} />
            <SummaryPill label={t('pbl.v2.hero.task')} value={`${completedTasks}/${totalTasks}`} />
            {instructor?.name && (
              <SummaryPill label={t('pbl.v2.hero.tutor')} value={instructor.name} />
            )}
          </div>
        </header>

        {(textOrNull(project.learningObjective) || (project.gains ?? []).some(Boolean)) && (
          <section className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5">
            <SectionHeading>{t('pbl.v2.hero.youWillLearn')}</SectionHeading>
            {textOrNull(project.learningObjective) && (
              <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
                {shortText(project.learningObjective, 1000)}
              </p>
            )}
            {(project.gains ?? []).filter((gain) => textOrNull(gain)).length > 0 && (
              <ul className="mt-3 grid gap-2 sm:grid-cols-2">
                {(project.gains ?? [])
                  .map((gain) => textOrNull(gain))
                  .filter((gain): gain is string => !!gain)
                  .map((gain) => (
                    <li
                      key={gain}
                      className="rounded-xl border border-cyan-200/[0.12] bg-cyan-300/[0.06] px-3 py-2 text-sm text-slate-200"
                    >
                      {gain}
                    </li>
                  ))}
              </ul>
            )}
          </section>
        )}

        <section className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5">
          <SectionHeading>{t('pbl.v2.sidebar.title')}</SectionHeading>
          <p className="mt-1 text-xs text-slate-400">
            {t('pbl.v2.sidebar.summary', {
              completed: completedTasks,
              total: totalTasks,
              stages: milestones.length,
            })}
          </p>
          <div className="mt-4 space-y-3">
            {milestones.map((milestone, index) => (
              <MilestoneSummary key={milestone.id} milestone={milestone} index={index} t={t} />
            ))}
          </div>
        </section>

        {project.scenario && <ScenarioSummary project={project} t={t} />}

        {evaluation && <EvaluationSummary evaluation={evaluation} t={t} />}

        {submissions.length > 0 && (
          <SubmissionSummary submissions={submissions} project={project} t={t} />
        )}

        {messages.length > 0 && <TranscriptSummary messages={messages} project={project} t={t} />}
      </div>
    </div>
  );
}

function SectionHeading({ children }: { readonly children: ReactNode }) {
  return <h2 className="text-sm font-semibold tracking-tight text-white">{children}</h2>;
}

function StatusBadge({ status, label }: { readonly status: string; readonly label?: string }) {
  return (
    <span
      className={`shrink-0 rounded-full border px-2.5 py-1 text-[11px] font-medium ${statusTone(normalizedStatus(status))}`}
    >
      {label ?? status}
    </span>
  );
}

function SummaryPill({ label, value }: { readonly label: string; readonly value: string }) {
  return (
    <span className="rounded-full border border-white/[0.10] bg-black/10 px-3 py-1.5">
      <span className="text-slate-400">{label}: </span>
      <span className="font-medium text-slate-200">{value}</span>
    </span>
  );
}

function MilestoneSummary({
  milestone,
  index,
  t,
}: {
  readonly milestone: PBLMilestone;
  readonly index: number;
  readonly t: Translate;
}) {
  const tasks = [...milestone.microtasks].sort((a, b) => a.order - b.order);
  return (
    <article className="rounded-xl border border-white/[0.08] bg-black/[0.12] p-4">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="flex min-w-0 items-start gap-2.5">
          <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-primary/20 text-[11px] font-bold text-cyan-100">
            {index + 1}
          </span>
          <div className="min-w-0">
            <h3 className="text-sm font-semibold text-slate-100">{milestone.title}</h3>
            {textOrNull(milestone.description) && (
              <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
                {shortText(milestone.description, 700)}
              </p>
            )}
          </div>
        </div>
        <StatusBadge status={milestone.status} label={statusLabel(milestone.status, t)} />
      </div>

      {tasks.length > 0 && (
        <ul className="mt-3 space-y-1.5 border-l border-white/[0.10] pl-4">
          {tasks.map((task) => (
            <TaskSummary key={task.id} task={task} t={t} />
          ))}
        </ul>
      )}
    </article>
  );
}

function TaskSummary({ task, t }: { readonly task: PBLMicrotask; readonly t: Translate }) {
  return (
    <li className="flex items-start justify-between gap-2 rounded-lg px-2 py-1.5 text-xs">
      <div className="min-w-0">
        <p className="font-medium text-slate-200">{task.title}</p>
        {textOrNull(task.description) && (
          <p className="mt-0.5 whitespace-pre-wrap leading-relaxed text-slate-400">
            {shortText(task.description, 450)}
          </p>
        )}
      </div>
      <StatusBadge status={task.status} label={statusLabel(task.status, t)} />
    </li>
  );
}

function ScenarioSummary({
  project,
  t,
}: {
  readonly project: PBLProjectV2;
  readonly t: Translate;
}) {
  const scenario = project.scenario;
  if (!scenario) return null;
  const characters = scenario.characters ?? [];
  return (
    <section className="rounded-2xl border border-violet-200/[0.12] bg-violet-300/[0.05] p-5">
      <SectionHeading>{t('pbl.v2.scene.label')}</SectionHeading>
      {textOrNull(scenario.setting) && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
          {shortText(scenario.setting, 900)}
        </p>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        {textOrNull(scenario.learnerRole) && (
          <LabeledText label={t('pbl.v2.briefing.learnerRole')} value={scenario.learnerRole} />
        )}
        {textOrNull(scenario.goal) && (
          <LabeledText label={t('pbl.v2.briefing.goal')} value={scenario.goal} />
        )}
        {textOrNull(scenario.rules) && (
          <LabeledText label={t('pbl.v2.briefing.rules')} value={scenario.rules} />
        )}
      </div>
      {characters.length > 0 && (
        <div className="mt-4">
          <p className="text-xs font-medium uppercase tracking-wider text-violet-200/75">
            {t('pbl.v2.briefing.cast')}
          </p>
          <ul className="mt-2 grid gap-2 sm:grid-cols-2">
            {characters.map((character) => (
              <li
                key={character.id}
                className="rounded-xl border border-white/[0.08] bg-black/[0.12] p-3"
              >
                <p className="text-sm font-semibold text-slate-100">{character.name}</p>
                {textOrNull(character.persona) && (
                  <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-400">
                    {shortText(character.persona, 500)}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function LabeledText({ label, value }: { readonly label: string; readonly value: unknown }) {
  const text = shortText(value, 700);
  if (!text) return null;
  return (
    <div className="rounded-xl border border-white/[0.08] bg-black/[0.12] p-3">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-violet-200/70">
        {label}
      </p>
      <p className="mt-1 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">{text}</p>
    </div>
  );
}

function EvaluationSummary({
  evaluation,
  t,
}: {
  readonly evaluation: PBLEvaluation;
  readonly t: Translate;
}) {
  return (
    <section className="rounded-2xl border border-amber-200/[0.12] bg-amber-300/[0.05] p-5">
      <SectionHeading>{t('pbl.v2.taskEvalCard.title')}</SectionHeading>
      {textOrNull(evaluation.feedback) && (
        <p className="mt-2 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
          {shortText(evaluation.feedback, 1200)}
        </p>
      )}
      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <EvaluationList label={t('pbl.v2.taskEvalCard.strengths')} items={evaluation.strengths} />
        <EvaluationList
          label={t('pbl.v2.taskEvalCard.improvements')}
          items={evaluation.improvements}
        />
      </div>
      {(evaluation.whatYouBuilt?.length || evaluation.whatYouLearned?.length) && (
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <EvaluationList
            label={t('pbl.v2.completion.whatYouBuilt')}
            items={evaluation.whatYouBuilt ?? []}
          />
          <EvaluationList
            label={t('pbl.v2.completion.whatYouLearned')}
            items={evaluation.whatYouLearned ?? []}
          />
        </div>
      )}
    </section>
  );
}

function EvaluationList({
  label,
  items,
}: {
  readonly label: string;
  readonly items: readonly string[];
}) {
  const values = items.map((item) => textOrNull(item)).filter((item): item is string => !!item);
  if (values.length === 0) return null;
  return (
    <div>
      <p className="text-xs font-medium uppercase tracking-wider text-amber-100/70">{label}</p>
      <ul className="mt-1.5 list-disc space-y-1 pl-4 text-xs leading-relaxed text-slate-300">
        {values.map((item) => (
          <li key={item}>{shortText(item, 500)}</li>
        ))}
      </ul>
    </div>
  );
}

function SubmissionSummary({
  submissions,
  project,
  t,
}: {
  readonly submissions: readonly PBLSubmission[];
  readonly project: PBLProjectV2;
  readonly t: Translate;
}) {
  const taskTitles = new Map(
    project.milestones.flatMap((milestone) =>
      milestone.microtasks.map((task) => [task.id, task.title] as const),
    ),
  );
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5">
      <SectionHeading>{t('pbl.v2.submission.submissionHistory')}</SectionHeading>
      <ul className="mt-3 space-y-2">
        {submissions.map((submission) => (
          <li
            key={submission.id}
            className="rounded-xl border border-white/[0.08] bg-black/[0.12] p-3"
          >
            <div className="flex flex-wrap items-center justify-between gap-2">
              <p className="text-xs font-semibold text-slate-200">
                {t('pbl.v2.submission.fromTask', {
                  title: taskTitles.get(submission.microtaskId) ?? submission.microtaskId,
                })}
              </p>
              <span className="text-[10px] uppercase tracking-wider text-slate-500">
                {submission.kind}
              </span>
            </div>
            {textOrNull(submission.filename) && (
              <p className="mt-1 text-xs text-slate-400">{submission.filename}</p>
            )}
            {(shortText(submission.summary) || shortText(submission.content)) && (
              <p className="mt-2 whitespace-pre-wrap text-xs leading-relaxed text-slate-300">
                {shortText(submission.summary) ?? shortText(submission.content)}
              </p>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

function TranscriptSummary({
  messages,
  project,
  t,
}: {
  readonly messages: ReturnType<typeof allMessages>;
  readonly project: PBLProjectV2;
  readonly t: Translate;
}) {
  const roleNames = new Map(project.roles.map((role) => [role.id, role.name] as const));
  return (
    <section className="rounded-2xl border border-white/[0.08] bg-white/[0.04] p-5">
      <SectionHeading>{t('pbl.v2.chat.roleplayHistoryTitle')}</SectionHeading>
      <div className="mt-3 space-y-2">
        {messages.map((message) => (
          <article
            key={message.id}
            className="rounded-xl border border-white/[0.07] bg-black/[0.12] p-3"
          >
            <p className="text-[10px] font-semibold uppercase tracking-wider text-cyan-200/70">
              {message.roleType === 'user'
                ? t('pbl.v2.hero.tutor')
                : (roleNames.get(message.agentId ?? '') ?? message.roleType)}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-relaxed text-slate-300">
              {shortText(message.content, 1200)}
            </p>
          </article>
        ))}
      </div>
    </section>
  );
}
