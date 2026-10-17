# TickTick: verified reading workflow

This is a project-specific guide based on current Coke acceptance, not an upstream universal site skill.

- Starting view for today: `https://ticktick.com/webapp/#q/today/tasks`; reuse the user-authorized `ticktick` profile through the trusted coordinator.
- Check actual rendered application content, not just the URL or a 200 response. A sign-in page, loading shell or verification prompt is not an authenticated task list. Legacy `window.SiteStatus` is not reliable authentication evidence in the current webapp; host login detection has its own validated profile/status checks.
- For scheduling/date interpretation use the user's configured zone; this project's current user convention is Asia/Shanghai. Do not infer a due date from surrounding dates or convert a task's date inside a verbatim quote.
- Prefer an observed 今天/Today navigation control if the correct view is not active. Use its current ref, then read again. Never reuse a ref from a past run or save refs into this guide.
- Preserve the read-only scope. Avoid task checkboxes, editing, dragging, completion, deletion, adding reminders, or changing preferences.
- The current text snapshot can include sidebar, overdue tasks, date headings and unrelated lists. Do not label every captured line as a task or attach a nearby date/list to a title without evidence.
- If exporting visible content, use `answer-report` with an actual supplied observation step, preferably `{step:N}` so the host copies captured text. Optional quotes must be contiguous and verbatim. The host's report header explicitly says captured excerpts only. Keep URLs, list names and deadlines unknown when not observed.
- Current acceptance covers saved login reuse and partial visible exports. No scroll/pagination tools, full inventory guarantee, or reliable per-task detail extraction have been verified. Complete-list requests must disclose this boundary rather than treating the visible viewport as all tasks.
- Report verification can fail when the model rewrites quotes or uses the wrong observation step. Correct by selecting a provided observation with `{step:N}` or supplying a verified exact quote, not by weakening the verifier or creating an unverified substitute report.
