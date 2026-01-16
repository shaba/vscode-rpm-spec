import * as cp from 'child_process';
import * as path from 'path';
import * as rl from 'readline';
import * as vscode from 'vscode';
import { LanguageClient, LanguageClientOptions, ServerOptions } from 'vscode-languageclient/node';

const MODE = {
    language: 'rpm-spec',
    scheme: 'file'
};

const SEVERITY = {
    W: vscode.DiagnosticSeverity.Warning,
    E: vscode.DiagnosticSeverity.Error
};

let diagnostics: vscode.DiagnosticCollection;
let lspClient: LanguageClient | undefined;

interface RPMLintContext {
    path: string;
    options: cp.SpawnOptions;
}

function checkSanity(ctx: RPMLintContext): Promise<number | null> {
    return new Promise((resolve) => {
        cp.spawn(ctx.path, ['--help'], ctx.options)
            .on('exit', (code) => resolve(code))
            .on('error', (error) => {
                vscode.window.showWarningMessage('rpmlint cannot be launched: ' + error);
                resolve(null);
            });
    });
}

function getLintContext(document: vscode.TextDocument): RPMLintContext {
    const config = vscode.workspace.getConfiguration('rpmspec');
    const rpmlintPath = config.get<string>('rpmlintPath', 'rpmlint');
    const workspaceFolder = vscode.workspace.getWorkspaceFolder(document.uri);
    const cwd = workspaceFolder?.uri.fsPath ?? path.dirname(document.uri.fsPath);

    return {
        path: rpmlintPath,
        options: {
            env: {
                LANG: 'C',
                PATH: process.env.PATH ?? ''
            },
            cwd
        }
    };
}

function getSanityContext(): RPMLintContext {
    const config = vscode.workspace.getConfiguration('rpmspec');
    const rpmlintPath = config.get<string>('rpmlintPath', 'rpmlint');
    const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();

    return {
        path: rpmlintPath,
        options: {
            env: {
                LANG: 'C',
                PATH: process.env.PATH ?? ''
            },
            cwd
        }
    };
}

function lint(document: vscode.TextDocument) {
    if (document.languageId !== MODE.language) {
        return;
    }

    if (document.uri.scheme !== MODE.scheme || document.isUntitled) {
        return;
    }

    const config = vscode.workspace.getConfiguration('rpmspec');
    if (!config.get<boolean>('lint', true)) {
        diagnostics.delete(document.uri);
        return;
    }

    const ctx = getLintContext(document);
    const filePath = document.uri.fsPath;

    const linter = cp.spawn(ctx.path, [filePath], ctx.options);
    const reader = rl.createInterface({ input: linter.stdout });
    const array: vscode.Diagnostic[] = [];

    const escapedFilePath = filePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const diagnosticPattern = new RegExp(`^${escapedFilePath}:(?:(?<line>\\d+):)?\\s*(?<severity>\\S)+:\\s*(?<body>.+)$`);

    reader.on('line', (line: string) => {
        const match = diagnosticPattern.exec(line);

        if (match !== null) {
            const lineNumber = match.groups?.line ? Number(match.groups.line) - 1 : 0;
            const safeLineNumber = Math.min(Math.max(lineNumber, 0), Math.max(document.lineCount - 1, 0));
            const diagnosticRange = document.lineAt(safeLineNumber).range;

            const diagnostic = new vscode.Diagnostic(
                diagnosticRange,
                match.groups?.body ?? 'Unknown rpmlint warning',
                SEVERITY[match.groups?.severity ?? 'W'] ?? vscode.DiagnosticSeverity.Warning
            );

            array.push(diagnostic);
        }
    });

    reader.on('close', () => {
        diagnostics.set(document.uri, array);
    });

    linter.on('error', (error) => {
        vscode.window.showWarningMessage('rpmlint failed: ' + error);
        diagnostics.set(document.uri, []);
    });
}

function checkLspAvailable(serverPath: string, options: cp.SpawnOptions): Promise<boolean> {
    return new Promise((resolve) => {
        cp.spawn(serverPath, ['--help'], options)
            .on('exit', () => resolve(true))
            .on('error', () => resolve(false));
    });
}

export function activate(context: vscode.ExtensionContext) {
    const sanityContext = getSanityContext();
    const config = vscode.workspace.getConfiguration('rpmspec');
    const lspEnabled = config.get<boolean>('lsp', true);
    const lspPath = config.get<string>('lspPath', 'rpm_lsp_server');

    checkSanity(sanityContext).then((exitCode) => {
        if (!exitCode && config.get<boolean>('lint', true)) {
            diagnostics = vscode.languages.createDiagnosticCollection('rpm-spec');

            vscode.workspace.onDidOpenTextDocument(doc => lint(doc));
            vscode.workspace.onDidSaveTextDocument(doc => lint(doc));
            vscode.workspace.textDocuments.forEach(doc => lint(doc));
            vscode.workspace.onDidCloseTextDocument((document) => {
                diagnostics.delete(document.uri);
            });

            context.subscriptions.push(diagnostics);
        }
    });

    if (!lspEnabled) {
        return;
    }

    checkLspAvailable(lspPath, sanityContext.options).then((available) => {
        if (!available) {
            return;
        }

        const cwd = typeof sanityContext.options.cwd === 'string' ? sanityContext.options.cwd : undefined;
        const serverOptions: ServerOptions = {
            command: lspPath,
            args: ['--stdio'],
            options: {
                cwd,
                env: sanityContext.options.env
            }
        };

        const clientOptions: LanguageClientOptions = {
            documentSelector: [{ language: MODE.language, scheme: MODE.scheme }]
        };

        lspClient = new LanguageClient(
            'rpm-spec-lsp',
            'RPM Spec Language Server',
            serverOptions,
            clientOptions
        );

        lspClient.start();
        context.subscriptions.push(lspClient);
    });
}

export function deactivate() {
    if (lspClient) {
        void lspClient.stop();
    }
}
