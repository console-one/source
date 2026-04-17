export enum Mutation {
  ADDITION = 0,
  DELETION = 1
}

export class SourceChange {
  
  public readonly length: number;
  
  constructor(
    public  index: number,
    public change: string,
    public readonly type: Mutation,
    public readonly timestamp: number
  ) {
    this.length = change.length;
  }

  static fromJSON(json: any) {
    return new SourceChange(json.index, json.change, json.type, json.timestamp);
  }
}
