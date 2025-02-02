/**
 * Copyright (C) 2022 Jeff Shee (jeffshee8969@gmail.com)
 *
 * This program is free software: you can redistribute it and/or modify
 * it under the terms of the GNU General Public License as published by
 * the Free Software Foundation, either version 3 of the License, or
 * (at your option) any later version.
 *
 * This program is distributed in the hope that it will be useful,
 * but WITHOUT ANY WARRANTY; without even the implied warranty of
 * MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
 * GNU General Public License for more details.
 *
 * You should have received a copy of the GNU General Public License
 * along with this program.  If not, see <https://www.gnu.org/licenses/>.
 */

/**
 * Special thanks to the black magic of DING extension.
 * Especially the ManageWindow class that gives superpower to Wayland windows.
 * That is one of the most crucial parts for this extension to work.
 * Also, the replaceMethod function is very convenient and helpful.
 * Without them, I don't know how to get started.
 */

 const { Meta, Gio, GLib } = imports.gi;

 const Main = imports.ui.main;
 
 const ExtensionUtils = imports.misc.extensionUtils;
 const Config = imports.misc.config;
 
 const Me = ExtensionUtils.getCurrentExtension();
 const EmulateX11 = Me.imports.emulateX11WindowType;
 const GnomeShellOverride = Me.imports.gnomeShellOverride;
 
 const isDebugMode = true;
 
 function debug(...args) {
     if (isDebugMode) log("[Hanabi]", ...args);
 }
 
 // This object will contain all the global variables
 let data = {};
 
 class Extension {
     enable() {
         if (!data.GnomeShellOverride) {
             data.GnomeShellOverride = new GnomeShellOverride.GnomeShellOverride();
         }
 
         if (!data.x11Manager) {
             data.x11Manager = new EmulateX11.EmulateX11WindowType();
         }
 
         // If the desktop is still starting up, wait until it is ready
         if (Main.layoutManager._startingUp) {
             data.startupPreparedId = Main.layoutManager.connect("startup-complete", () => {
                 innerEnable(true);
             });
         } else {
             innerEnable(false);
         }
     }
 
     disable() {
         data.isEnabled = false;
         killCurrentProcess();
         data.GnomeShellOverride.disable();
         data.x11Manager.disable();
     }
 }
 
 function init() {
     data.isEnabled = false;
     data.launchRendererId = 0;
     data.currentProcess = null;
     data.reloadTime = 100;
     data.GnomeShellVersion = parseInt(Config.PACKAGE_VERSION.split(".")[0]);
 
     data.GnomeShellOverride = null;
     data.x11Manager = null;
 
     /**
      * Ensures that there aren't "rogue" processes.
      * This is a safeguard measure for the case of Gnome Shell being relaunched
      *  (for example, under X11, with Alt+F2 and R), to kill any old renderer instance.
      * That's why it must be here, in init(), and not in enable() or disable()
      * (disable already guarantees thag the current instance is killed).
      */
     doKillAllOldRendererProcesses();
     return new Extension();
 }
 
 /**
  * The true code that configures everything and launches the renderer
  */
 function innerEnable(removeId) {
     if (removeId) {
         Main.layoutManager.disconnect(data.startupPreparedId);
         data.startupPreparedId = null;
     }
 
     data.GnomeShellOverride.enable();
 
     // under X11 we don't need to cheat, so only do all this under wayland
     if (Meta.is_wayland_compositor()) {
         data.x11Manager.enable();
     }
 
     data.isEnabled = true;
     if (data.launchRendererId) {
         GLib.source_remove(data.launchRendererId);
     }
 
     launchRenderer();
 }
 
 /**
  * Kills the current renderer
  */
 function killCurrentProcess() {
     // If a reload was pending, kill it and program a new reload
     if (data.launchRendererId) {
         GLib.source_remove(data.launchRendererId);
         data.launchRendererId = 0;
         if (data.isEnabled) {
             data.launchRendererId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, data.reloadTime, () => {
                 data.launchRendererId = 0;
                 launchRenderer();
                 return false;
             });
         }
     }
 
     // kill the renderer. It will be reloaded automatically.
     if (data.currentProcess && data.currentProcess.subprocess) {
         data.currentProcess.cancellable.cancel();
         data.currentProcess.subprocess.send_signal(15);
     }
 }
 
 /**
  * This function checks all the processes in the system,
  * and kills those that are a desktop manager from the current user (but not others).
  * This allows to avoid having several ones in case gnome shell resets, or other odd cases.
  * It requires the /proc virtual filesystem, but doesn't fail if it doesn't exist.
  */
 function doKillAllOldRendererProcesses() {
     let procFolder = Gio.File.new_for_path("/proc");
     if (!procFolder.query_exists(null)) {
         return;
     }
 
     let fileEnum = procFolder.enumerate_children("standard::*", Gio.FileQueryInfoFlags.NONE, null);
     let info;
     while ((info = fileEnum.next_file(null))) {
         let filename = info.get_name();
         if (!filename) {
             break;
         }
         let processPath = GLib.build_filenamev(["/proc", filename, "cmdline"]);
         let processUser = Gio.File.new_for_path(processPath);
         if (!processUser.query_exists(null)) {
             continue;
         }
         let [binaryData, etag] = processUser.load_bytes(null);
         let contents = "";
         let readData = binaryData.get_data();
         for (let i = 0; i < readData.length; i++) {
             if (readData[i] < 32) {
                 contents += " ";
             } else {
                 contents += String.fromCharCode(readData[i]);
             }
         }
         let path = "gjs " + GLib.build_filenamev([ExtensionUtils.getCurrentExtension().path, "renderer.js"]);
         if (contents.startsWith(path)) {
             let proc = new Gio.Subprocess({ argv: ["/bin/kill", filename] });
             proc.init(null);
             proc.wait(null);
         }
     }
 }
 
 /**
  * Launches the renderer, passing to it the path where it is stored and the video path to play.
  * It also monitors it, to relaunch it in case it dies or is killed.
  * Finally, it reads STDOUT and STDERR and redirects them to the journal, to help to debug it.
  */
 function launchRenderer() {
     data.reloadTime = 100;
     let argv = [];
     argv.push(GLib.build_filenamev([ExtensionUtils.getCurrentExtension().path, "renderer.js"]));
     // The path. Allows the program to find translations, settings and modules.
     argv.push("-P");
     argv.push(ExtensionUtils.getCurrentExtension().path);
 
     data.currentProcess = new LaunchSubprocess(0, "Hanabi", "-U");
     data.currentProcess.set_cwd(GLib.get_home_dir());
     data.currentProcess.spawnv(argv);
     data.x11Manager.set_wayland_client(data.currentProcess);
 
     /**
      * If the renderer dies, wait 100ms and relaunch it, unless the exit status is different than zero,
      * in which case it will wait one second. This is done this way to avoid relaunching the renderer
      * too fast if it has a bug that makes it fail continuously, avoiding filling the journal too fast.
      */
     data.currentProcess.subprocess.wait_async(null, (obj, res) => {
         let b = obj.wait_finish(res);
         if (!data.currentProcess || obj !== data.currentProcess.subprocess) {
             return;
         }
         if (obj.get_if_exited()) {
             let retval = obj.get_exit_status();
             if (retval != 0) {
                 data.reloadTime = 1000;
             }
         } else {
             data.reloadTime = 1000;
         }
         data.currentProcess = null;
         data.x11Manager.set_wayland_client(null);
         if (data.isEnabled) {
             if (data.launchRendererId) {
                 GLib.source_remove(data.launchRendererId);
             }
             data.launchRendererId = GLib.timeout_add(GLib.PRIORITY_DEFAULT, data.reloadTime, () => {
                 data.launchRendererId = 0;
                 launchRenderer();
                 return false;
             });
         }
     });
 }
 
 /**
  * This class encapsulates the code to launch a subprocess that can detect whether a window belongs to it.
  * It only accepts to do it under Wayland, because under X11 there is no need to do these tricks.
  *
  * It is compatible with https://gitlab.gnome.org/GNOME/mutter/merge_requests/754 to simplify the code.
  *
  * @param {int} flags Flags for the SubprocessLauncher class
  * @param {string} process_id An string id for the debug output
  * @param {string} cmd_parameter A command line parameter to pass when running. It will be passed only under Wayland,
  *                               so, if this parameter isn't passed, the app can assume that it is running under X11.
  */
 var LaunchSubprocess = class {
     constructor(flags, process_id, cmd_parameter) {
         this._process_id = process_id;
         this._cmd_parameter = cmd_parameter;
         this._UUID = null;
         this._flags = flags | Gio.SubprocessFlags.STDOUT_PIPE | Gio.SubprocessFlags.STDERR_MERGE;
         this.cancellable = new Gio.Cancellable();
         this._launcher = new Gio.SubprocessLauncher({ flags: this._flags });
         if (Meta.is_wayland_compositor()) {
             this._waylandClient = Meta.WaylandClient.new(this._launcher);
             if (Config.PACKAGE_VERSION == "3.38.0") {
                 // workaround for bug in 3.38.0
                 this._launcher.ref();
             }
         }
         this.subprocess = null;
         this.process_running = false;
     }
 
     spawnv(argv) {
         if (Meta.is_wayland_compositor()) {
             this.subprocess = this._waylandClient.spawnv(global.display, argv);
         } else {
             this.subprocess = this._launcher.spawnv(argv);
         }
         // This is for GLib 2.68 or greater
         if (this._launcher.close) {
             this._launcher.close();
         }
         this._launcher = null;
         if (this.subprocess) {
             /**
              * It reads STDOUT and STDERR and sends it to the journal using global.log().
              * This allows to have any error from the renderer in the same journal than other extensions.
              * Every line from the renderer is prepended with the "process_id" parameter sent in the constructor.
              */
             this._dataInputStream = Gio.DataInputStream.new(this.subprocess.get_stdout_pipe());
             this.read_output();
             this.subprocess.wait_async(this.cancellable, () => {
                 this.process_running = false;
                 this._dataInputStream = null;
                 this.cancellable = null;
             });
             this.process_running = true;
         }
         return this.subprocess;
     }
 
     set_cwd(cwd) {
         this._launcher.set_cwd(cwd);
     }
 
     read_output() {
         if (!this._dataInputStream) {
             return;
         }
         this._dataInputStream.read_line_async(GLib.PRIORITY_DEFAULT, this.cancellable, (object, res) => {
             try {
                 const [output, length] = object.read_line_finish_utf8(res);
                 if (length) print(`${this._process_id}: ${output}`);
             } catch (e) {
                 if (e.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED)) return;
 
                 logError(e, `${this._process_id}_Error`);
             }
 
             this.read_output();
         });
     }
 
     /**
      * Queries whether the passed window belongs to the launched subprocess or not.
      * @param {MetaWindow} window The window to check.
      */
     query_window_belongs_to(window) {
         if (!Meta.is_wayland_compositor()) {
             return false;
         }
         if (!this.process_running) {
             return false;
         }
         try {
             return this._waylandClient.owns_window(window);
         } catch (e) {
             return false;
         }
     }
 
     show_in_window_list(window) {
         if (Meta.is_wayland_compositor() && this.process_running) {
             this._waylandClient.show_in_window_list(window);
         }
     }
 
     hide_from_window_list(window) {
         if (Meta.is_wayland_compositor() && this.process_running) {
             this._waylandClient.hide_from_window_list(window);
         }
     }
 };
 