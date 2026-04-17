import { Mutation, SourceChange } from './change.js'
import { Label, LabelChange } from './label.js'

function getLabelChangeKey(labelChange: LabelChange, mutationType) : string {
  if (labelChange.update[0] === mutationType) {
    let labelAdded: Label = (labelChange.update[1] as Label);
    return labelAdded.key;
  } else {
    return (labelChange.update[1] as string)
  }
}

export type Direction = 'FORWARD' | 'BACKWARD'

export const Transformations = {

  applyCodeChanges(sourceText: string, sourceChanges: SourceChange[], direction: Direction = 'FORWARD') : string {
    let sourceChangeIndex = 0;
    let characterIndex = 0;
    let newSource = '';

    while (characterIndex < sourceText.length || sourceChangeIndex < sourceChanges.length) {
      let nextSourceIndex;

      if (sourceChangeIndex < sourceChanges.length) {
        nextSourceIndex = sourceChanges[sourceChangeIndex].index;
        newSource += sourceText.slice(characterIndex, nextSourceIndex);

        let additions = [];
        let deletions = [];

        let isDeletion = direction === 'FORWARD' ? Mutation.DELETION : Mutation.ADDITION;

        while (sourceChangeIndex < sourceChanges.length &&
          sourceChanges[sourceChangeIndex].index === nextSourceIndex) {
          if (sourceChanges[sourceChangeIndex].type === isDeletion) {
            deletions.push(sourceChanges[sourceChangeIndex]);
          } else {
            additions.push(sourceChanges[sourceChangeIndex]);
          }
          sourceChangeIndex += 1;
        }

        let additionLength = 0;
        for (let i = 0; i < additions.length; i++) {
          newSource += additions[i].change;
          additionLength += additions[i].change.length;
        }

        let deletionLength = 0;
        for (let i = 0; i < deletions.length; i++) {
          deletionLength += deletions[i].change.length;
        }

        characterIndex = (nextSourceIndex + deletionLength);

      } else {

        newSource += sourceText.slice(characterIndex, nextSourceIndex);

        nextSourceIndex = sourceText.length;
        characterIndex = sourceText.length;


      }
    }
    return newSource;
  },



  applyLabelChanges(labels: Label[], labelChanges: LabelChange[], direction: Direction = 'FORWARD'): Label[] {
    let isAddition = direction === 'FORWARD' ? Mutation.ADDITION : Mutation.DELETION;

    let initialStateByKey: Map<string, any> = labels.reduce((labelsByKey, label) => {
      labelsByKey.set(label.key, label);
      return labelsByKey;
    }, new Map<string, any>());


    let changesByKey: Map<string, LabelChange> = labelChanges.reduce((changes, labelChange) => {
      let labelKey = getLabelChangeKey(labelChange, isAddition);
      if (changes.has(labelKey)) {
        let currentChange: LabelChange = changes.get(labelKey)!;
        if (currentChange.timestamp < labelChange.timestamp) {
          changes.set(labelKey, labelChange);
        }
      } else {
        changes.set(labelKey, labelChange);
      }
      return changes;
    }, new Map<string, LabelChange>());

    for (let key of changesByKey.keys()) {
      let mostRecentChange: LabelChange = changesByKey.get(key)!;
      if (mostRecentChange.update[0] === isAddition) {
        initialStateByKey.set(key, (mostRecentChange.update[1] as Label));
      } else {
        if (initialStateByKey.has(key)) {
          initialStateByKey.delete(key);
        }
      }
    }

    let finalLabels: Label[] = [];
    for (let finalLabelKey of initialStateByKey.keys()) {
      let labelObj = initialStateByKey.get(finalLabelKey);  // some old states that we get directly from redis is not of class Label
      finalLabels.push(new Label(labelObj.key, labelObj.value));
    }
    return finalLabels;
  }
}
