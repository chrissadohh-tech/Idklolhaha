use eframe::{egui, App, Frame, NativeOptions};
use std::collections::VecDeque;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Instant;

const BG:     egui::Color32 = egui::Color32::from_rgb(8, 8, 8);
const PANEL:  egui::Color32 = egui::Color32::from_rgb(14, 14, 14);
const TERM:   egui::Color32 = egui::Color32::from_rgb(6, 6, 6);
const LINE:   egui::Color32 = egui::Color32::from_rgb(230, 230, 230);
const FG:     egui::Color32 = egui::Color32::from_rgb(245, 245, 245);
const DIM:    egui::Color32 = egui::Color32::from_rgb(170, 170, 170);
const FAINT:  egui::Color32 = egui::Color32::from_rgb(120, 120, 120);
const GREEN:  egui::Color32 = egui::Color32::from_rgb(220, 220, 220);
const RED:    egui::Color32 = egui::Color32::from_rgb(235, 101, 96);
const AMBER:  egui::Color32 = egui::Color32::from_rgb(240, 180, 90);
const GREY:   egui::Color32 = egui::Color32::from_rgb(90, 90, 90);

/// State shared between the tokio servers (writers) and the GUI (reader).
pub struct UiShared {
    pub studio_running: AtomicBool,
    /// Same flag McpRuntime flips on spawn/reset — one Arc, two views.
    pub mcp_alive: Arc<AtomicBool>,
    pub workspace_ready: AtomicBool,
    pub full_access: std::sync::RwLock<Arc<AtomicBool>>,
    pub workspace_root: Mutex<String>,
    pub fatal: Mutex<Option<String>>,
    pub logs: Mutex<VecDeque<String>>,
}

const LOG_CAP: usize = 800;
const VERSION: &str = env!("CARGO_PKG_VERSION");

impl UiShared {
    pub fn new(mcp_alive: Arc<AtomicBool>) -> Self {
        Self {
            studio_running: AtomicBool::new(false),
            mcp_alive,
            workspace_ready: AtomicBool::new(false),
            full_access: std::sync::RwLock::new(Arc::new(AtomicBool::new(false))),
            workspace_root: Mutex::new(String::new()),
            fatal: Mutex::new(None),
            logs: Mutex::new(VecDeque::with_capacity(LOG_CAP)),
        }
    }

    pub fn attach_workspace(&self, root: String, full_flag: Arc<AtomicBool>) {
        if let Ok(mut r) = self.workspace_root.lock() { *r = root; }
        self.workspace_ready.store(true, Ordering::Relaxed);
        let current = self.full_access.read().map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
        full_flag.store(current, Ordering::Relaxed);
        if let Ok(mut slot) = self.full_access.write() { *slot = full_flag; }
    }

    pub fn log(&self, chunk: &str) {
        let mut logs = self.logs.lock().unwrap_or_else(|e| e.into_inner());
        for line in chunk.lines() {
            let trimmed = line.trim_end();
            if trimmed.is_empty() { continue; }
            if logs.len() == LOG_CAP { logs.pop_front(); }
            logs.push_back(trimmed.to_string());
        }
    }

    pub fn clear_logs(&self) {
        if let Ok(mut l) = self.logs.lock() { l.clear(); }
    }

    pub fn set_fatal(&self, msg: String) {
        let mut f = self.fatal.lock().unwrap_or_else(|e| e.into_inner());
        if f.is_none() { *f = Some(msg); }
    }
}

#[derive(Clone, Copy, PartialEq)]
enum Level { Info, Warn, Err }

fn line_level(line: &str) -> Level {
    let head = &line[..line.len().min(90)];
    if head.contains("ERROR") { Level::Err }
    else if head.contains("WARN") { Level::Warn }
    else { Level::Info }
}

fn level_color(l: Level) -> egui::Color32 {
    match l {
        Level::Err => RED,
        Level::Warn => AMBER,
        Level::Info => egui::Color32::from_rgb(200, 200, 200),
    }
}

pub struct AgentApp {
    shared: Arc<UiShared>,
    restart_tx: tokio::sync::mpsc::UnboundedSender<()>,
    booted: Instant,
    log_filter: usize,
}

impl AgentApp {
    fn dot(ui: &mut egui::Ui, color: egui::Color32) {
        let (rect, _) = ui.allocate_exact_size(egui::vec2(10.0, 10.0), egui::Sense::hover());
        ui.painter().circle_stroke(rect.center(), 3.5, egui::Stroke::new(1.2, color));
        ui.painter().circle_filled(rect.center(), 1.6, color);
    }
}

impl App for AgentApp {
    fn update(&mut self, ctx: &egui::Context, _frame: &mut Frame) {
        ctx.request_repaint_after(std::time::Duration::from_millis(500));

        let mut do_restart = false;
        let mut do_clear = false;
        let mut new_filter = self.log_filter;
        ctx.input(|i| {
            for ev in &i.events {
                if let egui::Event::Key { key, pressed: true, modifiers, .. } = ev {
                    if modifiers.any() { continue; }
                    match key {
                        egui::Key::R => do_restart = true,
                        egui::Key::C => do_clear = true,
                        egui::Key::Num1 => new_filter = 0,
                        egui::Key::Num2 => new_filter = 1,
                        egui::Key::Num3 => new_filter = 2,
                        egui::Key::Num4 => new_filter = 3,
                        _ => {}
                    }
                }
            }
        });
        if do_restart { let _ = self.restart_tx.send(()); }
        if do_clear { self.shared.clear_logs(); }
        self.log_filter = new_filter;

        let s = &self.shared;
        let studio_on = s.studio_running.load(Ordering::Relaxed);
        let mcp_on = s.mcp_alive.load(Ordering::Relaxed);
        let as_on = s.workspace_ready.load(Ordering::Relaxed);
        let full_on = s.full_access.read().map(|f| f.load(Ordering::Relaxed)).unwrap_or(false);
        let root = s.workspace_root.lock().map(|r| r.clone()).unwrap_or_default();

        egui::CentralPanel::default()
            .frame(egui::Frame::none().fill(BG).inner_margin(egui::Margin::symmetric(14.0, 11.0)))
            .show(ctx, |ui| {
                ui.horizontal_wrapped(|ui| {
                    ui.label(egui::RichText::new("OR Agent").size(16.0).strong().color(FG));
                    ui.label(egui::RichText::new(format!("v{VERSION}")).size(10.0).color(GREY));
                    ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                        if ui.small_button("Restart MCP").clicked() {
                            let _ = self.restart_tx.send(());
                        }
                        let up = self.booted.elapsed();
                        let txt = if up.as_secs() >= 3600 {
                            format!("up {}h{:02}m", up.as_secs() / 3600, (up.as_secs() % 3600) / 60)
                        } else {
                            format!("up {}m{:02}s", up.as_secs() / 60, up.as_secs() % 60)
                        };
                        ui.label(egui::RichText::new(txt).size(10.0).color(GREY));
                    });
                });

                if let Some(msg) = s.fatal.lock().unwrap_or_else(|e| e.into_inner()).clone() {
                    ui.add_space(8.0);
                    egui::Frame::none()
                        .fill(egui::Color32::from_rgba_unmultiplied(RED.r(), RED.g(), RED.b(), 30))
                        .stroke(egui::Stroke::new(1.0, RED))
                        .rounding(egui::Rounding::same(8.0))
                        .inner_margin(egui::Margin::symmetric(10.0, 6.0))
                        .show(ui, |ui| {
                            ui.add(egui::Label::new(
                                egui::RichText::new(format!("FATAL: {msg}")).size(11.5).strong().color(RED))
                                .wrap());
                        });
                }

                ui.add_space(12.0);

                egui::Frame::none()
                    .fill(PANEL)
                    .stroke(egui::Stroke::new(1.0_f32, LINE))
                    .rounding(egui::Rounding::same(4.0))
                    .inner_margin(egui::Margin::symmetric(13.0, 10.0))
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());

                        engine_row(ui, FG, "Roblox Studio", "Studio MCP",
                            if studio_on && mcp_on { "connected" } else if studio_on { "app open" } else { "offline" },
                            studio_on && mcp_on);
                        ui.separator();
                        engine_row(ui, FG, "AgentScript", "FS + terminal",
                            if as_on { "ready" } else { "offline" }, as_on);

                        ui.add_space(8.0);
                        ui.horizontal_wrapped(|ui| {
                            ui.label(egui::RichText::new("workspace").size(9.5).color(FAINT));
                            ui.label(egui::RichText::new(if root.is_empty() { "(not set)".to_string() } else { root.clone() })
                                .monospace().size(10.5).color(DIM));
                        });
                        ui.add_space(6.0);
                        ui.horizontal_wrapped(|ui| {
                            ui.spacing_mut().item_spacing.x = 16.0;
                            svc(ui, "mcp helper", mcp_on);
                            svc(ui, "http :3000", true);
                            if full_on {
                                AgentApp::dot(ui, RED);
                                ui.label(egui::RichText::new("FULL PC ACCESS").size(9.5).strong().color(RED));
                            }
                        });
                        ui.add_space(8.0);
                        ui.horizontal_wrapped(|ui| {
                            ui.label(egui::RichText::new("permissions").size(9.5).color(FAINT));
                            ui.add_space(8.0);
                            let sandbox_on = !full_on;
                            if ui.add(egui::Button::new(
                                egui::RichText::new("Sandbox").size(10.5).color(if sandbox_on { FG } else { DIM }).strong()
                            ).fill(if sandbox_on { egui::Color32::from_rgb(32, 32, 32) } else { egui::Color32::TRANSPARENT })
                             .stroke(if sandbox_on { egui::Stroke::new(1.0, LINE) } else { egui::Stroke::new(1.0, GREY) })
                             .small()).clicked() {
                                if let Ok(f) = s.full_access.read() { f.store(false, Ordering::Relaxed); }
                            }
                            if ui.add(egui::Button::new(
                                egui::RichText::new("Full PC").size(10.5).color(if full_on { RED } else { DIM }).strong()
                            ).fill(if full_on { egui::Color32::from_rgb(40, 16, 16) } else { egui::Color32::TRANSPARENT })
                             .stroke(if full_on { egui::Stroke::new(1.0, RED) } else { egui::Stroke::new(1.0, GREY) })
                             .small()).clicked() {
                                if let Ok(f) = s.full_access.read() { f.store(true, Ordering::Relaxed); }
                            }
                        });
                    });

                ui.add_space(10.0);

                egui::Frame::none()
                    .fill(TERM)
                    .stroke(egui::Stroke::new(1.0_f32, LINE))
                    .rounding(egui::Rounding::same(4.0))
                    .inner_margin(egui::Margin::ZERO)
                    .show(ui, |ui| {
                        ui.set_min_width(ui.available_width());
                        ui.horizontal_wrapped(|ui| {
                            ui.add_space(12.0);
                            ui.label(egui::RichText::new("CONSOLE").size(9.5).strong().color(DIM));
                            ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
                                ui.add_space(10.0);
                                if ui.small_button("Clear").clicked() { s.clear_logs(); }
                                let names = ["ALL", "INFO", "WARN", "ERR"];
                                for (i, n) in names.iter().enumerate().rev() {
                                    let sel = self.log_filter == i;
                                    let label = egui::RichText::new(*n).size(9.5)
                                        .color(if sel { FG } else { DIM }).strong();
                                    if ui.add(egui::Button::new(label)
                                        .fill(if sel { egui::Color32::from_rgb(32, 32, 32) } else { egui::Color32::TRANSPARENT })
                                        .stroke(if sel { egui::Stroke::new(1.0, LINE) } else { egui::Stroke::NONE })
                                        .small()).clicked() {
                                        self.log_filter = i;
                                    }
                                }
                            });
                        });
                        ui.separator();

                        let min_level = match self.log_filter {
                            1 => Some(Level::Info),
                            2 => Some(Level::Warn),
                            3 => Some(Level::Err),
                            _ => None,
                        };
                        egui::ScrollArea::vertical()
                            .auto_shrink([false, false])
                            .stick_to_bottom(true)
                            .show(ui, |ui| {
                                egui::Frame::none().inner_margin(egui::Margin::symmetric(12.0, 8.0)).show(ui, |ui| {
                                    let logs = s.logs.lock().unwrap_or_else(|e| e.into_inner());
                                    let mut shown = 0usize;
                                    for line in logs.iter() {
                                        let lvl = line_level(line);
                                        let passes = match min_level {
                                            None | Some(Level::Info) => true,
                                            Some(Level::Warn) => lvl != Level::Info,
                                            Some(Level::Err) => lvl == Level::Err,
                                        };
                                        if !passes { continue; }
                                        shown += 1;
                                        ui.add(egui::Label::new(
                                            egui::RichText::new(line).monospace().size(11.0).color(level_color(lvl)))
                                            .wrap());
                                    }
                                    if shown == 0 {
                                        ui.label(egui::RichText::new(if logs.is_empty() {
                                            "or-agent — waiting for activity…"
                                        } else {
                                            "no lines match this filter"
                                        }).monospace().size(11.0).color(GREY));
                                    }
                                    ui.add_space(4.0);
                                    ui.horizontal(|ui| {
                                        ui.label(egui::RichText::new("$ ").monospace().size(11.5).color(GREEN));
                                    });
                                });
                            });
                    });

                ui.add_space(6.0);
                ui.horizontal_wrapped(|ui| {
                    ui.label(egui::RichText::new(
                        "keys  R restart-mcp · C clear · 1-4 filter      ports  http 3000 · ws 17613/17615")
                        .size(9.0).color(FAINT));
                });
            });
    }
}

fn engine_row(
    ui: &mut egui::Ui,
    accent: egui::Color32,
    name: &str,
    sub: &str,
    state: &str,
    on: bool,
) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 8.0;
        AgentApp::dot(ui, if on { accent } else { GREY });
        ui.vertical(|ui| {
            ui.label(egui::RichText::new(name).strong().size(13.0).color(FG));
            ui.label(egui::RichText::new(sub).size(9.5).color(FAINT));
        });
        ui.with_layout(egui::Layout::right_to_left(egui::Align::Center), |ui| {
            ui.label(egui::RichText::new(state).size(10.5).strong()
                .color(if on { accent } else { GREY }));
        });
    });
}

fn svc(ui: &mut egui::Ui, name: &str, ok: bool) {
    ui.horizontal(|ui| {
        ui.spacing_mut().item_spacing.x = 5.0;
        AgentApp::dot(ui, if ok { GREEN } else { GREY });
        ui.label(egui::RichText::new(name).size(9.5).color(DIM));
    });
}

pub fn run_gui(
    shared: Arc<UiShared>,
    restart_tx: tokio::sync::mpsc::UnboundedSender<()>,
) -> eframe::Result<()> {
    let options = NativeOptions {
        viewport: egui::ViewportBuilder::default()
            .with_inner_size([720.0, 580.0])
            .with_min_inner_size([380.0, 320.0])
            .with_title("OR"),
        ..Default::default()
    };
    eframe::run_native(
        "OR",
        options,
        Box::new(move |_cc| Ok(Box::new(AgentApp { shared, restart_tx, booted: Instant::now(), log_filter: 0 }))),
    )
}
