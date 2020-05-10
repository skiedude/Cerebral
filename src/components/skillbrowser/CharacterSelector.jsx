import React from 'react';

import { MenuItem, SelectField } from 'material-ui';

import Character from '../../models/Character';

export default class CharacterSelector extends React.Component {
    constructor(props) {
        super(props);
        this.state = {
            characterId: 0,
        };

        this.handleCharacterChange = this.handleCharacterChange.bind(this);

        const allChars = Character.getAll();

        this.chars = [];
        Object.keys(allChars).forEach((char) => {
            this.chars.push(<MenuItem key={char} value={char} primaryText={allChars[char].name} />);
        });

        // Make sure characters with numbers in names get sorted correctly ([1, 2, 11], not [1, 11, 2])
        var collator = new Intl.Collator(undefined, {numeric: true, sensitivity: "base"});
        this.chars.sort((a, b) => collator.compare(a.props.primaryText, b.props.primaryText));
    }

    handleCharacterChange(event, index, value) {
        this.setState({ characterId: value });
        this.props.onCharacterChange(value);
    }

    render() {
        return (
            <SelectField style={{ margin: 10 }}
                floatingLabelText="Character"
                value={this.state.characterId}
                onChange={this.handleCharacterChange}
            >
                {this.chars}
            </SelectField>
        );
    }
}
