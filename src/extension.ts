import * as vscode from 'vscode';
import * as fs from 'fs';
import * as path from 'path';
import { exec } from 'child_process';

let folderPath: string;
let config: vscode.WorkspaceConfiguration;

export async function activate(context: vscode.ExtensionContext) {
    // Register a completion provider for files
	vscode.workspace.getConfiguration().update("editor.hover.delay", 0, vscode.ConfigurationTarget.Global);
    config = vscode.workspace.getConfiguration('jenkins-library');
    const wsfolder = context.extensionPath;
    const repoPath = wsfolder + '/jenkins-library-repository'; // Path to clone the repository
    folderPath = wsfolder+'/jenkins-library-repository/vars';

    let disposable = vscode.languages.registerCompletionItemProvider(
        [
            { scheme: 'file', language: 'groovy' }, // For groovy files
            { scheme: 'file', language: 'jenkinsfile' } // For Jenkinsfile files
        ], {
        async provideCompletionItems(document: vscode.TextDocument, position: vscode.Position) {
            const functionNames = await getFileNamesInWorkspace();
			console.log(`functionNames: ${functionNames}`);

            // Convert function names to completion items
            const completionItems = functionNames.map(fileName => {
                const item = new vscode.CompletionItem(fileName);
                item.kind = vscode.CompletionItemKind.Function;
                return item;
            });

            return completionItems;
        }
    });

	let hoverArguments = vscode.languages.registerHoverProvider(
        [
            { scheme: 'file', language: 'groovy' }, // For groovy files
            { scheme: 'file', language: 'jenkinsfile' } // For Jenkinsfile files
        ],
        {
            async provideHover(document, position, token) {   
                const line = document.lineAt(position.line).text;                 // Use regular expression to extract the function name
                const functionNameRegex = /\b(\w+)\s*\(/;
                const match = functionNameRegex.exec(line);
                if (match) {
                    const functionName = match[1];
                    const filePath = folderPath+"\\"+functionName+".groovy"; // Replace this with the actual file path

                    // Read the content of the file
                    const fileContent = await readFile(filePath);

                    // Extract arguments of the "call" function
                    const callFunctionArguments = extractCallFunctionArguments(fileContent);
                    const argumentsDocumentation = extractArgumentsDocumentation(fileContent);
                    const usageDocumentation = extractUsageDocumentation(fileContent);

                    const char = document.getText(new vscode.Range(position, position.translate(0, 1)));
                    if (char === '(') {
                        let markdownContent = '### Arguments\n\n';
                        argumentsDocumentation.map(args => {
                            markdownContent += `- **${args["name"]}**: ${args["definition"].trim()}\n`;
                        });
                        let markdownUsageContent = '### Usage\n\n';
                        markdownUsageContent += `<span>${usageDocumentation}</span>\n`;
                        let markdownInformationContent = '### Information\n\n';
                        markdownInformationContent += `${functionName}(${callFunctionArguments.join(', ')})`;

                        const functionNamePosition = new vscode.Position(position.line, match.index);

                        if (position.isAfterOrEqual(functionNamePosition) && position.isBeforeOrEqual(functionNamePosition.translate(0, functionName.length))) {
                            // Provide hover information for the function name
                            return new vscode.Hover(`${markdownContent}\n---\n${markdownUsageContent}\n---\n${markdownInformationContent}`);
                        }
                    }
                }
                return null;
            }
        }
    );

    let repositoryManager = vscode.commands.registerCommand('jenkins-library.cloneRepo', async () => {
        const gitUrl = await vscode.window.showInputBox({
            prompt: 'Enter Git URL',
            placeHolder: 'https://github.com/username/repo.git'
        });

        const username = await vscode.window.showInputBox({
            prompt: 'Enter username'
        });

        const password = await vscode.window.showInputBox({
            prompt: 'Enter password',
            password: true // This hides the input (useful for passwords)
        });

        if (gitUrl && username && password) {
            // Check if repoPath directory exists
            if (fs.existsSync(repoPath)) {
                // If it exists, delete it recursively
                fs.rm(repoPath, ()=>{});
                vscode.window.showInformationMessage(`Deleted existing directory ${repoPath}`);
            }

            const childProcess = exec(`git clone ${gitUrl} ${repoPath}`, async (err, stdout, stderr) => {
                vscode.window.showInformationMessage(`Cloning to ${repoPath}`);

                if (err) {
                    console.error('Error:', err);
                    vscode.window.showErrorMessage('Failed to clone repository. Please check your credentials and try again.');
                } else {
                    await config.update('gitUrl', gitUrl, vscode.ConfigurationTarget.Global);
                    await config.update('username', username, vscode.ConfigurationTarget.Global);
        
                    vscode.window.showInformationMessage('Repository cloned successfully!');
                }
            });

            // Check if childProcess.stdin is not null before writing
            if (childProcess.stdin) {
                childProcess.stdin.write(`${username}\n${password}\n`);
            }

        } else {
            // User canceled input or didn't provide all required inputs
            vscode.window.showErrorMessage('Please provide all required inputs.');
        }
    });

    context.subscriptions.push(disposable);
    context.subscriptions.push(hoverArguments);
    context.subscriptions.push(repositoryManager);

    repositoryManager = vscode.commands.registerCommand('jenkins-library.pullBranch', async () => {
        const savedGitUrl = config.get('gitUrl');
        const branch = await vscode.window.showInputBox({
            prompt: 'Enter branch name to pull',
            placeHolder: 'main',
            value: 'main' // Default branch name
        });

        if (branch) {
            exec(`cd ${repoPath} && git checkout ${branch} && git pull origin ${branch}`, async (err, stdout, stderr) => {
                vscode.window.showInformationMessage(`Pulling from ${savedGitUrl}`);
                if (err) {
                    console.error('Error:', err);
                    vscode.window.showErrorMessage('Failed to pull changes from the repository.');
                } else {
                    vscode.window.showInformationMessage('Changes pulled successfully!');
                }
            });
        } else {
            // User canceled input
            vscode.window.showErrorMessage('Please provide the branch name.');
        }
    });
    context.subscriptions.push(repositoryManager);
}

function extractUsageDocumentation(fileContent: string): string {
    const regex = /Usage:(.*?)(?=\n\s*\n|\*\/)/s;

    const match = regex.exec(fileContent);
    if (match && match[1]) {
        const usage = match[1].trim(); // Trim any leading or trailing whitespace
        
        return usage;
    }
    return "";
}

function extractArgumentsDocumentation(fileContent: string): { name: string; definition: string; }[] {
    const regex = /Arguments:(.*?)(?=\n\s*\n|\*\/)/s;
    const argumentsList = [];
    const match = regex.exec(fileContent);
    if (match && match[1]) {
        // Define the regex pattern for extracting argument names and definitions
        const argRegex = /\s+(\w+)\s*-\s*([^]*?)(?=\s+\w+\s*-\s*|$)/g;
        let argMatch;

        // Iterate over matches in the Arguments section
        while ((argMatch = argRegex.exec(match[1])) !== null) {
            argumentsList.push({ name: argMatch[1], definition: argMatch[2] });
        }
    }

    return argumentsList;
}

function parseComment(commentContent: string): { [arg: string]: string } {
    const argRegex = /\s+(\w+)\s*-\s*(.*?)(?=\s+\w+\s*-\s*|$)/g;
    const argumentsDocumentation: { [arg: string]: string } = {};

    let match: RegExpExecArray | null;
    while ((match = argRegex.exec(commentContent)) !== null) {
        const argName = match[1];
        const argDescription = match[2];
        argumentsDocumentation[argName] = argDescription.trim();
    }

    return argumentsDocumentation;
}

function extractCallFunctionArguments(fileContent: string): string[] {
    const callFunctionRegex = /call\s*\(\s*([^)]+)\s*\)/g;
    const callFunctionArguments: string[] = [];
    let match: RegExpExecArray | null;
    while ((match = callFunctionRegex.exec(fileContent)) !== null) {
        const argumentsStr = match[1];
        // Split the arguments string by commas
        const argumentsList = argumentsStr.split(',').map(arg => arg.trim());
        callFunctionArguments.push(...argumentsList);
    }
    return callFunctionArguments;
}

async function getFileNamesInWorkspace(): Promise<string[]> {
	return new Promise((resolve, reject) => {
		let fileNamesWithoutExtensions: string[] = [];

		// Check if the folder exists
		fs.access(folderPath, fs.constants.F_OK, (err) => {
			if (err) {
				console.error(`Folder ${folderPath} does not exist or is not accessible.`);
				reject(`Error reading directory: ${err}`);
				return;
			}

			// Read the contents of the folder
			fs.readdir(folderPath, (err, files) => {
				if (err) {
					console.error(`Error reading folder ${folderPath}:`, err);
					return;
				}

				// Output the list of files in the folder
				fileNamesWithoutExtensions = removeExtensions(files);
				console.log(`Files in folder ${folderPath}:`, fileNamesWithoutExtensions);

				resolve(fileNamesWithoutExtensions);
			});
		});
	});
}

function removeExtensions(fileNames: string[]): string[] {
    return fileNames.map(fileName => path.parse(fileName).name);
}

function readFile(filePath: string): Promise<string> {
    return new Promise((resolve, reject) => {
        fs.readFile(filePath, 'utf8', (err, data) => {
            if (err) {
                reject(err);
            } else {
                resolve(data);
            }
        });
    });
}

// This method is called when your extension is deactivated
export function deactivate() {}
