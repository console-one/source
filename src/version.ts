export class Version {

    constructor(public version: number) {
    }

    toJSON() {
        return { version: this.version }
    }

    static fromJSON(json: any) {
        return new Version(json.version);
    }
}