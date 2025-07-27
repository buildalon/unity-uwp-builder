import core = require('@actions/core');
import glob = require('@actions/glob');
import path = require('path');
import fs = require('fs');
import { exec } from '@actions/exec';
import { UwpProject } from './types';
import { getUwpProjectInputs } from './inputs';

const main = async () => {
    try {
        if (process.platform !== `win32`) { throw new Error(`This action can only be performed on a Windows runner.`); }
        const project: UwpProject = await getUwpProjectInputs();
        const buildArgs = [
            `/t:Build`,
            `/p:AppxBundle=Always`,
            `/p:Configuration=${project.configuration}`,
        ];
        if (project.buildPlatform.length > 0) {
            buildArgs.push(`/p:Platform=${project.buildPlatform.join('|')}`);
        }
        switch (project.packageType) {
            case `upload`:
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=StoreUpload`,
                );
                break;
            case `sideload`:
                buildArgs.push(
                    `/p:UapAppxPackageBuildMode=SideloadOnly`,
                );
                break;
            default:
                throw new Error(`Invalid package type: "${project.packageType}"`);
        }
        buildArgs.push(
            `/p:PackageCertificateKeyFile="${project.certificatePath}"`,
        );
        if (project.certificatePassword) {
            buildArgs.push(
                `/p:PackageCertificateThumbprint=""`, // intentionally empty to force cert verification
                `/p:PackageCertificatePassword="${project.certificatePassword}"`
            );
        }
        if (project.outputDirectory) {
            buildArgs.push(
                `/p:AppxBundleOutput="${project.outputDirectory}"`,
            );
        }
        const additionalArgs = core.getInput(`additional-args`);
        if (additionalArgs) {
            core.info(`additional-args: "${additionalArgs}"`);
            buildArgs.push(...additionalArgs);
        }
        if (project.windowsSdkVersion) {
            buildArgs.push(`/p:WindowsTargetPlatformVersion=${project.windowsSdkVersion}`);
        }
        if (!core.isDebug()) {
            buildArgs.push(`/verbosity:minimal`);
        }
        core.startGroup(`Final MSBuild arguments:`);
        buildArgs.forEach(arg => core.info(`  ${arg}`));
        core.endGroup();
        core.startGroup(`MSBuild`);
        try {
            await exec(`msbuild`, [`"${project.projectSolutionPath}"`, ...buildArgs], {
                windowsVerbatimArguments: true
            });
        } finally {
            core.endGroup();
        }
        const outputDirectory = project.outputDirectory || path.join(project.projectDirectory, project.projectName, `AppPackages`);
        try {
            await fs.promises.access(outputDirectory, fs.constants.R_OK);
        } catch (error) {
            throw new Error(`Output directory not found: "${outputDirectory}".`);
        }
        core.info(`outputDirectory: ${outputDirectory}`);
        core.setOutput(`output-directory`, outputDirectory);
        const allGlobber = await glob.create(path.join(outputDirectory, '**/*'));
        const allFiles = await allGlobber.glob();
        core.startGroup(`All files found in output directory:`);
        allFiles.forEach(file => core.info(`  - "${file}"`));
        core.endGroup();
        const bundleExts = ['appxupload', 'msixupload', 'appxbundle', 'msixbundle', 'appx', 'msix'];
        const bundles = allFiles.filter(f => bundleExts.some(ext => f.toLowerCase().endsWith(`.${ext}`)));
        if (bundles.length === 0) {
            throw new Error(`No bundle files found in output directory: "${outputDirectory}"!`);
        }
        core.startGroup(`Found bundles:`);
        bundles.forEach(bundle => core.info(`  - "${bundle}"`));
        core.endGroup();
        core.setOutput(`bundles`, JSON.stringify(bundles));
    } catch (error) {
        core.setFailed(error);
    }
}

main();
