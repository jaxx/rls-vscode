// Copyright 2017 The RLS Developers. See the COPYRIGHT
// file at the top-level directory of this distribution and at
// http://rust-lang.org/COPYRIGHT.
//
// Licensed under the Apache License, Version 2.0 <LICENSE-APACHE or
// http://www.apache.org/licenses/LICENSE-2.0> or the MIT license
// <LICENSE-MIT or http://opensource.org/licenses/MIT>, at your
// option. This file may not be copied, modified, or distributed
// except according to those terms.

'use strict';

import { runRlsViaRustup, rustupUpdate } from './rustup';
import { startSpinner, stopSpinner } from './spinner';
import { RLSConfiguration } from './configuration';
import { activateTaskProvider, deactivateTaskProvider } from './tasks';

import * as child_process from 'child_process';
import * as fs from 'fs';

import { workspace, ExtensionContext, TextEditor, TextEditorEdit, window, commands, OutputChannel } from 'vscode';
import { LanguageClient, LanguageClientOptions, Location, NotificationType, RevealOutputChannelOn,
    ServerOptions } from 'vscode-languageclient';
import * as is from 'vscode-languageclient/lib/utils/is';

export const CONFIGURATION = RLSConfiguration.loadFromWorkspace();

function getSysroot(env: Object): string | Error {
    const rustcSysroot = child_process.spawnSync(
        'rustup', ['run', 'nightly', 'rustc', '--print', 'sysroot'], {env}
    );

    if (rustcSysroot.error) {
        return new Error(`Error running \`rustc\`: ${rustcSysroot.error}`);
    }

    if (rustcSysroot.status > 0) {
        return new Error(`Error getting sysroot from \`rustc\`: exited with \`${rustcSysroot.status}\``);
    }

    if (!rustcSysroot.stdout || typeof rustcSysroot.stdout.toString !== 'function') {
        return new Error(`Couldn't get sysroot from \`rustc\`: Got no ouput`);
    }

    const sysroot = rustcSysroot.stdout.toString()
        .replace('\n', '').replace('\r', '');

    return sysroot;
}

// Make an evironment to run the RLS.
// Tries to synthesise RUST_SRC_PATH for Racer, if one is not already set.
function makeRlsEnv(): any {
    const env = process.env;

    if (process.env.RUST_SRC_PATH) {
        return env;
    }

    let result = getSysroot(env);
    if (result instanceof Error) {
        console.info(result.message);
        console.info(`Let's retry with extended $PATH`);
        env.PATH = `${env.HOME || '~'}/.cargo/bin:${env.PATH || ''}`;
        result = getSysroot(env);

        if (result instanceof Error) {
            console.warn('Error reading sysroot (second try)', result);
            window.showWarningMessage('RLS could not set RUST_SRC_PATH for Racer because it could not read the Rust sysroot.');
        }
    }
    if (typeof result === 'string') {
        console.info(`Setting sysroot to`, result);
        env.RUST_SRC_PATH = result + '/lib/rustlib/src/rust/src';
    }

    return env;
}

function makeRlsProcess(lcOutputChannel: OutputChannel | null): Promise<child_process.ChildProcess> {
    // Allow to override how RLS is started up.
    const rls_path = CONFIGURATION.rlsPath;
    const rls_root = CONFIGURATION.rlsRoot;

    let childProcessPromise: Promise<child_process.ChildProcess>;
    const env = makeRlsEnv();
    if (rls_path) {
        childProcessPromise = Promise.resolve(child_process.spawn(rls_path, [], { env }));
    } else if (rls_root) {
        childProcessPromise = Promise.resolve(child_process.spawn(
          'rustup', ['run', 'nighty', 'cargo', 'run', '--release'],
          {cwd: rls_root, env})
        );
    } else {
        childProcessPromise = runRlsViaRustup(env);
    }

    childProcessPromise.then((childProcess) => {
        childProcess.on('error', err => {
            if ((<any>err).code == 'ENOENT') {
                console.error('Could not spawn RLS process: ', err.message);
                window.showWarningMessage('Could not start RLS');
            } else {
                throw err;
            }
        });

        if (CONFIGURATION.logToFile) {
            const logPath = workspace.rootPath + '/rls' + Date.now() + '.log';
            const logStream = fs.createWriteStream(logPath, { flags: 'w+' });
            logStream.on('open', function (_f) {
                childProcess.stderr.addListener('data', function (chunk) {
                    logStream.write(chunk.toString());
                });
            }).on('error', function (err: any) {
                console.error("Couldn't write to " + logPath + ' (' + err + ')');
                logStream.end();
            });
        }

        if (CONFIGURATION.showStderrInOutputChannel) {
            childProcess.stderr.on('data', data => {
                if (lcOutputChannel) {
                    lcOutputChannel.append(is.string(data) ? data : data.toString('utf8'));
                    // With regards to focusing the output channel, treat RLS stderr
                    // as if it was of an RevealOutputChannelOn.Info severity
                    if (CONFIGURATION.revealOutputChannelOn <= RevealOutputChannelOn.Info) {
                        lcOutputChannel.show(true);
                    }
                }
            });
        }
    });

    return childProcessPromise.catch(() => {
        window.setStatusBarMessage('RLS could not be started');
        return Promise.reject(undefined);
    });
}

export function activate(context: ExtensionContext) {
    window.setStatusBarMessage('RLS: starting up');

    // FIXME(#66): Hack around stderr not being output to the window if ServerOptions is a function
    let lcOutputChannel: OutputChannel | null = null;

    warnOnRlsToml();
    // Check for deprecated env vars.
    if (process.env.RLS_PATH || process.env.RLS_ROOT) {
        window.showWarningMessage('Found deprecated environment variables (RLS_PATH or RLS_ROOT). Use `rls.path` or `rls.root` settings.');
    }

    const serverOptions: ServerOptions = () => autoUpdate().then(() => makeRlsProcess(lcOutputChannel));
    const clientOptions: LanguageClientOptions = {
        // Register the server for Rust files
        documentSelector: ['rust'],
        synchronize: { configurationSection: 'rust' },
        // Controls when to focus the channel rather than when to reveal it in the drop-down list
        revealOutputChannelOn: CONFIGURATION.revealOutputChannelOn,
        initializationOptions: { omitInitBuild: true },
    };

    // Create the language client and start the client.
    const lc = new LanguageClient('Rust Language Server', serverOptions, clientOptions);
    lcOutputChannel = lc.outputChannel;

    diagnosticCounter(lc);
    registerCommands(lc, context);
    activateTaskProvider();

    const disposable = lc.start();
    context.subscriptions.push(disposable);
}

export function deactivate(): Promise<void> {
    deactivateTaskProvider();

    return Promise.resolve();
}

function warnOnRlsToml() {
    const tomlPath = workspace.rootPath + '/rls.toml';
    fs.access(tomlPath, fs.constants.F_OK, (err) => {
        if (!err) {
            window.showWarningMessage('Found deprecated rls.toml. Use VSCode user settings instead (File > Preferences > Settings)');
        }
    });
}

async function autoUpdate() {
    if (CONFIGURATION.updateOnStartup) {
        await rustupUpdate();
    }
}

function diagnosticCounter(lc: LanguageClient) {
    let runningDiagnostics = 0;
    lc.onReady().then(() => {
        lc.onNotification(new NotificationType('rustDocument/beginBuild'), function(_f) {
            runningDiagnostics++;
            startSpinner('RLS: working');
        });
        lc.onNotification(new NotificationType('rustDocument/diagnosticsEnd'), function(_f) {
            runningDiagnostics--;
            if (runningDiagnostics <= 0) {
                stopSpinner('RLS: done');
            }
        });
    });
}

function registerCommands(lc: LanguageClient, context: ExtensionContext) {
    const deglobDisposable = commands.registerTextEditorCommand('rls.deglob', (textEditor, _edit) => {
        lc.sendRequest('rustWorkspace/deglob', { uri: textEditor.document.uri.toString(), range: textEditor.selection })
            .then((_result) => {},
                  (reason) => {
                window.showWarningMessage('deglob command failed: ' + reason);
            });
    });
    context.subscriptions.push(deglobDisposable);

    const findImplsDisposable = commands.registerTextEditorCommand('rls.findImpls', (textEditor: TextEditor, _edit: TextEditorEdit) => {
        const params = lc.code2ProtocolConverter.asTextDocumentPositionParams(textEditor.document, textEditor.selection.active);
        const response = lc.sendRequest('rustDocument/implementations', params);
        response.then((locations: Location[]) => {
            commands.executeCommand('editor.action.showReferences', textEditor.document.uri, textEditor.selection.active, locations.map(lc.protocol2CodeConverter.asLocation));
        }, (reason) => {
            window.showWarningMessage('find implementations failed: ' + reason);
        });
    });
    context.subscriptions.push(findImplsDisposable);

    const rustupUpdateDisposable = commands.registerCommand('rls.update', () => {
        rustupUpdate();
    });
    context.subscriptions.push(rustupUpdateDisposable);
}
