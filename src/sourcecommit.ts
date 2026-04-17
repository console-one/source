export class SourceCommit {

    constructor(public path: string, public commitLabels: string[], public workspace: string) {
    }

    toJSON() {
        return { path: this.path, commitLabels: this.commitLabels, workspace: this.workspace }
    }

    static fromJSON(json: any) {
        return new SourceCommit(json.path, json.commitLabels, json.workspace);
    }
}