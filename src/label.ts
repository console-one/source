import { Mutation } from './change.js';

export class Label  {

  constructor(public key: string, public value: string) {
  }

  toJSON() {
    return { key: this.key, value: this.value }
  }

  static fromJSON(json: any) {
    return new Label(json.key, json.value);
  }
}

export class LabelChange {

  constructor(
    public timestamp: number,
    public update: [Mutation, Label | string]) {
  }

  static fromJSON(json: any) {
    return new LabelChange(json.timestamp, json.update); 
  }
}